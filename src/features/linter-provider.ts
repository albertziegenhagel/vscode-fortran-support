'use strict';

import * as path from 'path';
import * as cp from 'child_process';
import which from 'which';
import * as semver from 'semver';
import * as vscode from 'vscode';

import { Logger } from '../services/logging';
import { GNULinter, GNUModernLinter, IntelLinter, LFortranLinter, NAGLinter } from '../lib/linters';
import {
  EXTENSION_ID,
  resolveVariables,
  promptForMissingTool,
  isFreeForm,
  spawnAsPromise,
  isFortran,
  shellTask,
} from '../lib/tools';
import { arraysEqual } from '../lib/helper';
import { BuildDebug, BuildRun, RescanLint } from './commands';
import { GlobPaths } from '../lib/glob-paths';

export class LinterSettings {
  private _modernGNU: boolean;
  private _version: string;
  private config: vscode.WorkspaceConfiguration;

  constructor(private logger: Logger = new Logger()) {
    this.config = vscode.workspace.getConfiguration(EXTENSION_ID);
    this.GNUVersion(this.compiler); // populates version & modernGNU
  }
  public update(event: vscode.ConfigurationChangeEvent) {
    console.log('update settings');
    if (event.affectsConfiguration(`${EXTENSION_ID}.linter`)) {
      this.config = vscode.workspace.getConfiguration(EXTENSION_ID);
    }
  }

  public get enabled(): boolean {
    return this.config.get<string>('linter.compiler') !== 'Disabled';
  }
  public get compiler(): string {
    const compiler = this.config.get<string>('linter.compiler');
    return compiler;
  }
  public get compilerPath(): string {
    return this.config.get<string>('linter.compilerPath');
  }
  public get include(): string[] {
    return this.config.get<string[]>('linter.includePaths');
  }
  public get args(): string[] {
    return this.config.get<string[]>('linter.extraArgs');
  }
  public get modOutput(): string {
    return this.config.get<string>('linter.modOutput');
  }

  // END OF API SETTINGS

  /**
   * Returns the version of the compiler and populates the internal variables
   * `modernGNU` and `version`.
   * @note Only supports `gfortran`
   */
  private GNUVersion(compiler: string): string | undefined {
    // Only needed for gfortran's diagnostics flag
    this.modernGNU = false;
    if (compiler !== 'gfortran') return;
    const child = cp.spawnSync(compiler, ['--version']);
    if (child.error || child.status !== 0) {
      this.logger.error(`[lint] Could not spawn ${compiler} to check version.`);
      return;
    }
    // State the variables explicitly bc the TypeScript compiler on the CI
    // seemed to optimise away the stdout and regex would return null
    const regex = /^GNU Fortran \([\w.-]+\) (?<version>.*)$/gm;
    const output = child.stdout.toString();
    const match = regex.exec(output);
    const version = match ? match.groups.version : undefined;
    if (semver.valid(version)) {
      this.version = version;
      this.logger.info(`[lint] Found GNU Fortran version ${version}`);
      this.logger.debug(`[lint] Using Modern GNU Fortran diagnostics: ${this.modernGNU}`);
      return version;
    } else {
      this.logger.error(`[lint] invalid compiler version: ${version}`);
    }
  }

  public get version(): string {
    return this._version;
  }
  private set version(version: string) {
    this._version = version;
    this.modernGNU = semver.gte(version, '11.0.0');
  }
  public get modernGNU(): boolean {
    return this._modernGNU;
  }
  private set modernGNU(modernGNU: boolean) {
    this._modernGNU = modernGNU;
  }

  // FYPP options

  public get fyppEnabled(): boolean {
    // FIXME: fypp currently works only with gfortran
    if (this.compiler !== 'gfortran') {
      this.logger.warn(`[lint] fypp currently only supports gfortran.`);
      return false;
    }
    return this.config.get<boolean>('linter.fypp.enabled');
  }
  public get fyppPath(): string {
    return this.config.get<string>('linter.fypp.path');
  }
  public get fyppDefinitions(): { [name: string]: string } {
    return this.config.get<{ [name: string]: string }>('linter.fypp.definitions');
  }
  public get fyppIncludes(): string[] {
    return this.config.get<string[]>('linter.fypp.includes');
  }
  public get fyppLineNumberingMode(): string {
    return this.config.get<string>('linter.fypp.lineNumberingMode');
  }
  public get fyppLineMarkerFormat(): string {
    return this.config.get<string>('linter.fypp.lineMarkerFormat');
  }
  public get fyppExtraArgs(): string[] {
    return this.config.get<string[]>('linter.fypp.extraArgs');
  }
}

const GNU = new GNULinter();
const GNU_NEW = new GNUModernLinter();
const INTEL = new IntelLinter();
const NAG = new NAGLinter();
const LFORTRAN = new LFortranLinter();

export class FortranLintingProvider {
  constructor(private logger: Logger = new Logger()) {
    // Register the Linter provider
    this.fortranDiagnostics = vscode.languages.createDiagnosticCollection('Fortran');
    this.settings = new LinterSettings(this.logger);
  }

  private fortranDiagnostics: vscode.DiagnosticCollection;
  private compiler: string;
  private compilerPath: string;
  private pathCache = new Map<string, GlobPaths>();
  private settings: LinterSettings;
  private linter: GNULinter | GNUModernLinter | IntelLinter | NAGLinter;

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
    token: vscode.CancellationToken
  ): vscode.Command[] {
    return;
  }

  public async activate(subscriptions: vscode.Disposable[]) {
    // Register Linter commands
    subscriptions.push(vscode.commands.registerCommand(RescanLint, this.rescanLinter, this));
    subscriptions.push(
      vscode.commands.registerTextEditorCommand(
        BuildRun,
        async (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, ...args: any[]) => {
          await this.buildAndRun(textEditor);
        },
        this
      )
    );
    subscriptions.push(
      vscode.commands.registerTextEditorCommand(
        BuildDebug,
        async (textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, ...args: any[]) => {
          await this.buildAndDebug(textEditor);
        },
        this
      )
    );
    vscode.workspace.onDidOpenTextDocument(this.doLint, this, subscriptions);
    vscode.workspace.onDidCloseTextDocument(
      textDocument => {
        this.fortranDiagnostics.delete(textDocument.uri);
      },
      null,
      subscriptions
    );

    vscode.workspace.onDidSaveTextDocument(this.doLint, this);

    // Run gfortran in all open fortran files
    vscode.workspace.textDocuments.forEach(this.doLint, this);

    // Update settings on Configuration change
    vscode.workspace.onDidChangeConfiguration(e => {
      this.settings.update(e);
    });
  }

  public dispose(): void {
    this.fortranDiagnostics.clear();
    this.fortranDiagnostics.dispose();
  }

  private async doLint(textDocument: vscode.TextDocument) {
    // Only lint if a compiler is specified
    if (!this.settings.enabled) return;
    // Only lint Fortran (free, fixed) format files
    if (!isFortran(textDocument)) return;

    this.linter = this.getLinter(this.settings.compiler);
    const command = this.getLinterExecutable();
    const argList = this.constructArgumentList(textDocument);
    const filePath = path.parse(textDocument.fileName).dir;

    /*
     * reset localization settings to traditional C English behavior in case
     * gfortran is set up to use the system provided localization information,
     * so linterREGEX can nevertheless be used to filter out errors and warnings
     *
     * see also: https://gcc.gnu.org/onlinedocs/gcc/Environment-Variables.html
     */
    const env = process.env;
    env.LC_ALL = 'C';
    if (process.platform === 'win32') {
      // Windows needs to know the path of other tools
      if (!env.Path.includes(path.dirname(command))) {
        env.Path = `${path.dirname(command)}${path.delimiter}${env.Path}`;
      }
    }
    this.logger.info(`[lint] Compiler query command line: ${command} ${argList.join(' ')}`);

    try {
      const fypp = await this.getFyppProcess(textDocument);

      try {
        // The linter output is in the stderr channel
        const [stdout, stderr] = await spawnAsPromise(
          command,
          argList,
          { cwd: filePath, env: env },
          fypp?.[0], // pass the stdout from fypp to the linter as stdin
          true
        );
        const output: string = stdout + stderr;
        this.logger.debug(`[lint] Compiler output:\n${output}`);
        let diagnostics: vscode.Diagnostic[] = this.linter.parse(output);
        // Remove duplicates from the diagnostics array
        diagnostics = [...new Map(diagnostics.map(v => [JSON.stringify(v), v])).values()];
        this.fortranDiagnostics.set(textDocument.uri, diagnostics);
        return diagnostics;
      } catch (err) {
        this.logger.error(`[lint] Compiler error:`, err);
        console.error(`ERROR: ${err}`);
      }
    } catch (fyppErr) {
      this.logger.error(`[lint] fypp error:`, fyppErr);
      console.error(`ERROR: fypp ${fyppErr}`);
    }
  }

  private async buildAndRun(textEditor: vscode.TextEditor) {
    return this.buildAndDebug(textEditor, false);
  }

  /**
   * Compile and run the current file using the provided linter options.
   * It has the ability to launch a Debug session or just run the executable.
   * @param textEditor a text editor instance
   * @param debug performing a debug build or not
   */
  private async buildAndDebug(textEditor: vscode.TextEditor, debug = true): Promise<void> {
    const textDocument = textEditor.document;
    this.linter = this.getLinter(this.settings.compiler);
    const command = this.getLinterExecutable();
    let argList = this.constructArgumentList(textDocument);
    // Remove mandatory linter args, used for mock compilation
    argList = argList.filter(arg => !this.linter.args.includes(arg));
    if (debug) argList.push('-g'); // add debug symbols flag, same for all compilers
    try {
      await shellTask(command, argList, 'Build Fortran file');
      const folder: vscode.WorkspaceFolder = vscode.workspace.getWorkspaceFolder(
        textEditor.document.uri
      );
      const selectedConfig: vscode.DebugConfiguration = {
        name: `${debug ? 'Debug' : 'Run'} Fortran file`,
        // This relies on the C/C++ debug adapters
        type: process.platform === 'win32' ? 'cppvsdbg' : 'cppdbg',
        request: 'launch',
        program: `${textDocument.fileName}.o`,
        cwd: folder.uri.fsPath,
      };
      await vscode.debug.startDebugging(folder, selectedConfig, { noDebug: !debug });
      return;
    } catch (err) {
      this.logger.error(`[build] Compiling ${textDocument.fileName} failed:`, err);
      console.error(`ERROR: ${err}`);
    }
  }

  private getLinter(compiler: string): GNULinter | GNUModernLinter | IntelLinter | NAGLinter {
    switch (compiler) {
      case 'gfortran':
        if (this.settings.modernGNU) return GNU_NEW;
        return GNU;
      case 'ifx':
      case 'ifort':
        return INTEL;
      case 'nagfor':
        return NAG;
      case 'lfortran':
        return LFORTRAN;
      default:
        return GNU;
    }
  }

  private constructArgumentList(textDocument: vscode.TextDocument): string[] {
    const args = [...this.linter.args, ...this.getLinterExtraArgs(), ...this.getModOutputDir()];
    const opt = 'linter.includePaths';
    const includePaths = this.getGlobPathsFromSettings(opt);
    this.logger.debug(`[lint] glob paths:`, this.pathCache.get(opt).globs);
    this.logger.debug(`[lint] resolved paths:`, this.pathCache.get(opt).paths);

    // const extensionIndex = textDocument.fileName.lastIndexOf('.');
    // const fileNameWithoutExtension = textDocument.fileName.substring(0, extensionIndex);
    const fortranSource: string[] = this.settings.fyppEnabled
      ? ['-xf95', isFreeForm(textDocument) ? '-ffree-form' : '-ffixed-form', '-']
      : [textDocument.fileName];

    const argList = [
      ...args,
      ...this.getIncludeParams(includePaths), // include paths
      '-o',
      `${textDocument.fileName}.o`,
      ...fortranSource,
    ];

    return argList.map(arg => arg.trim()).filter(arg => arg !== '');
  }

  private getModOutputDir(): string[] {
    let modout: string = this.settings.modOutput;
    // let modFlag = '';
    // Return if no mod output directory is specified
    if (modout === '') return [];
    const modFlag = this.linter.modFlag;

    modout = resolveVariables(modout);
    this.logger.debug(`[lint] moduleOutput: ${modFlag} ${modout}`);
    return [modFlag, modout];
  }

  /**
   * Resolves, interpolates and expands internal variables and glob patterns
   * for the `linter.includePaths` option. The results are stored in a cache
   * to improve performance
   *
   * @param opt String representing a VS Code setting e.g. `linter.includePaths`
   *
   * @returns String Array of directories
   */
  private getGlobPathsFromSettings(opt: string): string[] {
    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    const globPaths: string[] = config.get(opt);
    // Initialise cache key and value if vscode option is not present
    if (!this.pathCache.has(opt)) {
      this.logger.debug(`[lint] Initialising cache for ${opt}`);
      try {
        this.pathCache.set(opt, new GlobPaths(globPaths));
      } catch (error) {
        const msg = `[lint] Error initialising cache for ${opt}`;
        this.logger.error(msg, error);
        vscode.window.showErrorMessage(`${msg}: ${error}`);
      }
    }
    // Check if cache is valid, and if so return cached value
    if (arraysEqual(globPaths, this.pathCache.get(opt).globs)) {
      return this.pathCache.get(opt).paths;
    }
    // Update cache and return new values
    try {
      this.pathCache.get(opt).update(globPaths);
    } catch (error) {
      const msg = `[lint] Error initialising cache for ${opt}`;
      this.logger.error(msg, error);
      vscode.window.showErrorMessage(`${msg}: ${error}`);
    }
    this.logger.debug(`[lint] ${opt} changed, updating cache`);
    return this.pathCache.get(opt).paths;
  }

  /**
   * Returns the linter executable i.e. this.compilerPath
   * @returns String with linter
   */
  private getLinterExecutable(): string {
    this.compiler = this.settings.compiler;
    this.compilerPath = this.settings.compilerPath;
    if (this.compilerPath === '') this.compilerPath = which.sync(this.compiler);
    this.logger.debug(`[lint] binary: "${this.compiler}" located in: "${this.compilerPath}"`);
    return this.compilerPath;
  }

  /**
   * Gets the additional linter arguments or sets the default ones if none are
   * specified.
   * Attempts to match and resolve any internal variables, but no glob support.
   *
   * @returns
   */
  private getLinterExtraArgs(): string[] {
    const config = vscode.workspace.getConfiguration(EXTENSION_ID);
    let args: string[] = this.linter.argsDefault;
    const user_args: string[] = this.settings.args;
    // If we have specified linter.extraArgs then replace default arguments
    if (user_args.length > 0) args = user_args.slice();
    // gfortran and flang have compiler flags for restricting the width of
    // the code.
    // You can always override by passing in the correct args as extraArgs
    if (this.linter.name === 'gfortran') {
      const ln: number = config.get('fortls.maxLineLength');
      const lnStr: string = ln === -1 ? 'none' : ln.toString();
      args.push(`-ffree-line-length-${lnStr}`, `-ffixed-line-length-${lnStr}`);
    }
    if (args.length > 0) this.logger.debug(`[lint] arguments:`, args);

    // Resolve internal variables but do not apply glob pattern matching
    return args.map(e => resolveVariables(e));
  }

  private getIncludeParams = (paths: string[]) => {
    return paths.map(path => `-I${path}`);
  };

  /**
   * Regenerate the cache for the include files paths of the linter
   */
  private rescanLinter() {
    const opt = 'linter.includePaths';
    this.logger.debug(`[lint] Resetting linter include paths cache`);
    this.logger.debug(`[lint] Current linter include paths cache:`, this.pathCache.get(opt).globs);
    this.pathCache.set(opt, new GlobPaths());
    this.getGlobPathsFromSettings(opt);
    this.logger.debug(`[lint] glob paths:`, this.pathCache.get(opt).globs);
    this.logger.debug(`[lint] resolved paths:`, this.pathCache.get(opt).paths);
  }

  /**
   * Parse a source file through the `fypp` preprocessor and return and active
   * process to parse as input to the main linter.
   *
   * This procedure does implements all the settings interfaces with `fypp`
   * and checks the system for `fypp` prompting to install it if missing.
   * @param document File name to pass to `fypp`
   * @returns Async spawned Promise containing `fypp` Tuple [`stdout` `stderr`] or `undefined` if `fypp` is disabled
   */
  private async getFyppProcess(document: vscode.TextDocument): Promise<[string, string]> {
    if (!this.settings.fyppEnabled) return undefined;
    let fypp: string = this.settings.fyppPath;
    fypp = process.platform !== 'win32' ? fypp : `${fypp}.exe`;

    // Check if the fypp is installed
    if (!which.sync(fypp, { nothrow: true })) {
      this.logger.warn(`[lint] fypp not detected in your system. Attempting to install now.`);
      const msg = `Installing fypp through pip with --user option`;
      promptForMissingTool('fypp', msg, 'Python', ['Install']);
    }
    const args: string[] = ['--line-numbering'];

    // Include paths to fypp, different from main linters include paths
    // fypp includes typically pointing to folders in a projects source tree.
    // While the -I options, you pass to a compiler in order to look up mod-files,
    // are typically pointing to folders in the projects build tree.
    const includePaths = this.settings.fyppIncludes;
    if (includePaths.length > 0) {
      args.push(...this.getIncludeParams(this.getGlobPathsFromSettings(`linter.fypp.includes`)));
    }

    // Set the output to Fixed Format if the source is Fixed
    if (!isFreeForm(document)) args.push('--fixed-format');

    const fypp_defs: { [name: string]: string } = this.settings.fyppDefinitions;
    if (Object.keys(fypp_defs).length > 0) {
      // Preprocessor definitions, merge with pp_defs from fortls?
      Object.entries(fypp_defs).forEach(([key, val]) => {
        if (val) args.push(`-D${key}=${val}`);
        else args.push(`-D${key}`);
      });
    }
    args.push(`--line-numbering-mode=${this.settings.fyppLineNumberingMode}`);
    args.push(`--line-marker-format=${this.settings.fyppLineMarkerFormat}`);
    args.push(...`${this.settings.fyppExtraArgs}`);

    // The file to be preprocessed
    args.push(document.fileName);

    const filePath = path.parse(document.fileName).dir;
    return await spawnAsPromise(fypp, args, { cwd: filePath }, undefined);
  }
}
