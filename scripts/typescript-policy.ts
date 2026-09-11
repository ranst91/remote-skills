import { isAbsolute, relative, resolve } from "node:path";

import {
  getLeadingCommentRanges,
  isBinaryExpression,
  isCallExpression,
  isExpressionStatement,
  isFunctionDeclaration,
  isFunctionLikeDeclaration,
  isIdentifier,
  isParenthesizedExpression,
  isPropertyAccessExpression,
  isReturnStatement,
  isVariableDeclaration,
  type Node,
  type SourceFile,
  SyntaxKind,
} from "typescript/unstable/ast";
import { API, type CompilerOptions, type Diagnostic } from "typescript/unstable/sync";

export const FINAL_AUTHORED_JAVASCRIPT_PATHS = [
  "apps/docs/postcss.config.mjs",
  "packages/sdk-typescript/src/cache/protocol-worker.mjs",
  "tests/protocol/adapters/typescript-protocol-adapter.mjs",
] as const;

export const VENDORED_PAKO_PATH = "packages/core/src/build/vendor/pako-deflate.mjs";
export const GENERATED_UNICODE_PATH = "packages/core/src/authoring/unicode-case-fold-v15.mjs";
export const IMMUTABLE_NOOP_FIXTURE_PATH = "tests/protocol/fixtures/adapters/typescript-noop.mjs";

export const TYPESCRIPT_PROJECT_CONFIG_PATHS = [
  "tsconfig.repository.json",
  "packages/core/tsconfig.json",
  "packages/core/tsconfig.build.json",
  "packages/cli/tsconfig.json",
  "packages/cli/tsconfig.build.json",
  "packages/sdk-typescript/tsconfig.json",
  "packages/sdk-typescript/tsconfig.build.json",
  "integrations/ai-sdk/tsconfig.json",
  "integrations/ai-sdk/tsconfig.build.json",
  "integrations/langchain/tsconfig.json",
  "integrations/langchain/tsconfig.build.json",
  "examples/langchain/tsconfig.json",
  "apps/docs/tsconfig.json",
  "examples/tsconfig.json",
  "examples/consumers/typescript/tsconfig.json",
] as const;

const requiredCompilerOptions = [
  "strict",
  "noImplicitAny",
  "useUnknownInCatchVariables",
  "exactOptionalPropertyTypes",
  "noUncheckedIndexedAccess",
  "forceConsistentCasingInFileNames",
] as const satisfies readonly (keyof CompilerOptions)[];

const implicitAnyDiagnosticCodes = new Set([
  7005, 7006, 7008, 7010, 7011, 7013, 7015, 7016, 7017, 7018, 7019, 7022, 7023, 7024, 7031, 7034,
  7051,
]);
const generatedSourceRoots = [
  resolve("apps/docs/.next"),
  resolve("examples/langchain/.next"),
  resolve("packages/sdk-typescript/dist"),
] as const;

export type TypeScriptPolicyDiagnosticKind =
  | "compiler-option"
  | "explicit-any"
  | "forbidden-ts-nocheck"
  | "implicit-any";

export interface TypeScriptPolicyDiagnostic {
  kind: TypeScriptPolicyDiagnosticKind;
  path: string;
  line: number;
  column: number;
  message: string;
}

export interface NoAnyPolicyOptions {
  projectConfigPaths: readonly string[];
  sourceFilePaths?: readonly string[];
  allowedTsNoCheckPath?: string;
  includeCompilerDiagnostics?: boolean;
}

function absolutePaths(paths: readonly string[]): string[] {
  return paths.map((path) => resolve(path));
}

function isGeneratedSource(path: string): boolean {
  return generatedSourceRoots.some((root) => {
    const pathFromRoot = relative(root, path);
    return pathFromRoot === "" || (!pathFromRoot.startsWith("..") && !isAbsolute(pathFromRoot));
  });
}

function projectOptionDiagnostics(
  configPath: string,
  compilerOptions: CompilerOptions,
): TypeScriptPolicyDiagnostic[] {
  const diagnostics: TypeScriptPolicyDiagnostic[] = [];
  for (const option of requiredCompilerOptions) {
    if (compilerOptions[option] !== true) {
      diagnostics.push({
        kind: "compiler-option",
        path: configPath,
        line: 1,
        column: 1,
        message: `${option} must be effectively enabled`,
      });
    }
  }
  return diagnostics;
}

export function checkEffectiveCompilerOptions(
  configPaths: readonly string[],
): TypeScriptPolicyDiagnostic[] {
  const resolvedConfigs = absolutePaths(configPaths);
  const api = new API();
  try {
    const snapshot = api.updateSnapshot({ openProjects: resolvedConfigs });
    try {
      const projectsByConfig = new Map(
        snapshot.getProjects().map((project) => [resolve(project.configFileName), project]),
      );
      const diagnostics: TypeScriptPolicyDiagnostic[] = [];
      for (const configPath of resolvedConfigs) {
        const project = projectsByConfig.get(configPath);
        if (project === undefined) {
          diagnostics.push({
            kind: "compiler-option",
            path: configPath,
            line: 1,
            column: 1,
            message: "TypeScript did not load this project configuration",
          });
          continue;
        }
        diagnostics.push(...projectOptionDiagnostics(configPath, project.compilerOptions));
      }
      return diagnostics;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

function sourcePosition(sourceFile: SourceFile, position: number) {
  const location = sourceFile.getLineAndCharacterOfPosition(position);
  return { line: location.line + 1, column: location.character + 1 };
}

function explicitAnyDiagnostics(sourceFile: SourceFile): TypeScriptPolicyDiagnostic[] {
  const diagnostics: TypeScriptPolicyDiagnostic[] = [];
  function visit(node: Node): void {
    if (node.kind === SyntaxKind.AnyKeyword) {
      const position = sourcePosition(sourceFile, node.getStart(sourceFile, true));
      diagnostics.push({
        kind: "explicit-any",
        path: resolve(sourceFile.fileName),
        ...position,
        message: "explicit TypeScript or JSDoc any is forbidden",
      });
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return diagnostics;
}

function tsNoCheckDiagnostic(
  sourceFile: SourceFile,
  allowedTsNoCheckPath: string | undefined,
): TypeScriptPolicyDiagnostic | undefined {
  const directive = "@ts-nocheck";
  for (const comment of getLeadingCommentRanges(sourceFile.text, 0) ?? []) {
    const directiveOffset = sourceFile.text.slice(comment.pos, comment.end).indexOf(directive);
    if (directiveOffset < 0 || resolve(sourceFile.fileName) === allowedTsNoCheckPath) continue;
    const position = comment.pos + directiveOffset;
    return {
      kind: "forbidden-ts-nocheck",
      path: resolve(sourceFile.fileName),
      ...sourcePosition(sourceFile, position),
      message: `${directive} is permitted only in the vendored pako source`,
    };
  }
  return undefined;
}

function implicitAnyDiagnostic(
  diagnostic: Diagnostic,
  sourceFile: SourceFile | undefined,
): TypeScriptPolicyDiagnostic | undefined {
  if (!implicitAnyDiagnosticCodes.has(diagnostic.code) || diagnostic.fileName === undefined) {
    return undefined;
  }
  const position =
    sourceFile === undefined
      ? { line: 1, column: diagnostic.pos + 1 }
      : sourcePosition(sourceFile, diagnostic.pos);
  return {
    kind: "implicit-any",
    path: resolve(diagnostic.fileName),
    ...position,
    message: `TS${diagnostic.code}: ${diagnostic.text}`,
  };
}

function isJsonParseCall(node: Node): boolean {
  return isCallExpression(node) && isJsonParseReference(node.expression);
}

function isJsonParseReference(node: Node): boolean {
  if (!isPropertyAccessExpression(node)) return false;
  const { expression, name } = node;
  return isIdentifier(expression) && expression.text === "JSON" && name.text === "parse";
}

function isUnknownTypeNode(node: Node | undefined): boolean {
  return node?.kind === SyntaxKind.UnknownKeyword;
}

function transparentBoundary(node: Node): Node {
  let boundary = node;
  while (
    isParenthesizedExpression(boundary.parent) ||
    boundary.parent.kind === SyntaxKind.AwaitExpression
  ) {
    boundary = boundary.parent;
  }
  return boundary;
}

interface BindingDeclaration {
  name: string;
  position: number;
  unknown: boolean;
}

interface UnknownParameterBoundary {
  name: string;
  unknownParameters: ReadonlySet<number>;
}

function isUnknownAssignmentTarget(
  name: string,
  position: number,
  declarations: readonly BindingDeclaration[],
): boolean {
  let nearest: BindingDeclaration | undefined;
  for (const declaration of declarations) {
    if (declaration.name !== name || declaration.position >= position) continue;
    if (nearest === undefined || declaration.position > nearest.position) nearest = declaration;
  }
  return nearest?.unknown === true;
}

function isUnknownBoundary(
  node: Node,
  declarations: readonly BindingDeclaration[],
  parameterBoundaries: readonly UnknownParameterBoundary[],
): boolean {
  const boundary = transparentBoundary(node);
  const parent = boundary.parent;
  if (isExpressionStatement(parent)) return true;
  if (isCallExpression(parent) && isIdentifier(parent.expression)) {
    let argumentIndex = -1;
    for (const [index, argument] of parent.arguments.entries()) {
      if (argument !== boundary) continue;
      argumentIndex = index;
      break;
    }
    const targetName = parent.expression.text;
    const target = parameterBoundaries.find(({ name }) => name === targetName);
    return argumentIndex >= 0 && target?.unknownParameters.has(argumentIndex) === true;
  }
  if (isVariableDeclaration(parent)) return isUnknownTypeNode(parent.type);
  if (
    isBinaryExpression(parent) &&
    parent.operatorToken.kind === SyntaxKind.EqualsToken &&
    parent.right === boundary &&
    isIdentifier(parent.left) &&
    isUnknownAssignmentTarget(parent.left.text, parent.left.pos, declarations)
  ) {
    return true;
  }
  if (!isReturnStatement(parent)) return false;

  let ancestor = parent.parent;
  while (!isFunctionLikeDeclaration(ancestor) && ancestor.kind !== SyntaxKind.SourceFile) {
    ancestor = ancestor.parent;
  }
  return isFunctionLikeDeclaration(ancestor) && isUnknownTypeNode(ancestor.type);
}

function inferredAnyDiagnostics(sourceFile: SourceFile): TypeScriptPolicyDiagnostic[] {
  const declarations: BindingDeclaration[] = [];
  const jsonParseAliases = new Set<string>();
  const parameterBoundaries: UnknownParameterBoundary[] = [];
  function collectDeclarations(node: Node): void {
    if (isVariableDeclaration(node) && isIdentifier(node.name)) {
      declarations.push({
        name: node.name.text,
        position: node.pos,
        unknown: isUnknownTypeNode(node.type),
      });
      if (node.initializer !== undefined && isJsonParseReference(node.initializer)) {
        jsonParseAliases.add(node.name.text);
      }
    }
    if (isFunctionDeclaration(node) && node.name !== undefined) {
      parameterBoundaries.push({
        name: node.name.text,
        unknownParameters: new Set(
          node.parameters.flatMap((parameter, index) =>
            isUnknownTypeNode(parameter.type) ? [index] : [],
          ),
        ),
      });
    }
    node.forEachChild(collectDeclarations);
  }
  collectDeclarations(sourceFile);

  const diagnostics: TypeScriptPolicyDiagnostic[] = [];
  function visit(node: Node): void {
    const anyReturningCall =
      isJsonParseCall(node) ||
      (isCallExpression(node) &&
        isIdentifier(node.expression) &&
        jsonParseAliases.has(node.expression.text));
    if (anyReturningCall && !isUnknownBoundary(node, declarations, parameterBoundaries)) {
      diagnostics.push({
        kind: "implicit-any",
        path: resolve(sourceFile.fileName),
        ...sourcePosition(sourceFile, node.getStart(sourceFile, true)),
        message: "JSON.parse returns any; quarantine the result as unknown and narrow before use",
      });
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  return diagnostics;
}

function compareDiagnostics(
  left: TypeScriptPolicyDiagnostic,
  right: TypeScriptPolicyDiagnostic,
): number {
  return (
    left.path.localeCompare(right.path) ||
    left.line - right.line ||
    left.column - right.column ||
    left.kind.localeCompare(right.kind)
  );
}

export function findNoAnyDiagnostics(options: NoAnyPolicyOptions): TypeScriptPolicyDiagnostic[] {
  const resolvedConfigs = absolutePaths(options.projectConfigPaths);
  const selectedSources =
    options.sourceFilePaths === undefined
      ? undefined
      : new Set(options.sourceFilePaths.map((path) => resolve(path)));
  const allowedTsNoCheckPath =
    options.allowedTsNoCheckPath === undefined ? undefined : resolve(options.allowedTsNoCheckPath);
  const api = new API();
  try {
    const snapshot = api.updateSnapshot({ openProjects: resolvedConfigs });
    try {
      const diagnostics: TypeScriptPolicyDiagnostic[] = [];
      const visitedSources = new Set<string>();
      for (const project of snapshot.getProjects()) {
        if (options.includeCompilerDiagnostics !== false) {
          for (const compilerDiagnostic of project.program.getSemanticDiagnostics()) {
            if (
              compilerDiagnostic.fileName !== undefined &&
              isGeneratedSource(resolve(compilerDiagnostic.fileName))
            ) {
              continue;
            }
            if (
              selectedSources !== undefined &&
              compilerDiagnostic.fileName !== undefined &&
              !selectedSources.has(resolve(compilerDiagnostic.fileName))
            ) {
              continue;
            }
            const diagnosticSource =
              compilerDiagnostic.fileName === undefined
                ? undefined
                : project.program.getSourceFile(compilerDiagnostic.fileName);
            const diagnostic = implicitAnyDiagnostic(compilerDiagnostic, diagnosticSource);
            if (diagnostic !== undefined) diagnostics.push(diagnostic);
          }
        }

        const sourcePaths =
          selectedSources ??
          new Set(
            project.rootFiles
              .map((path) => resolve(path))
              .filter((path) => !isGeneratedSource(path)),
          );
        for (const sourcePath of sourcePaths) {
          if (visitedSources.has(sourcePath)) continue;
          const sourceFile = project.program.getSourceFile(sourcePath);
          if (sourceFile === undefined || sourceFile.isDeclarationFile) continue;
          visitedSources.add(sourcePath);
          const noCheck = tsNoCheckDiagnostic(sourceFile, allowedTsNoCheckPath);
          if (noCheck !== undefined) diagnostics.push(noCheck);
          if (sourcePath !== allowedTsNoCheckPath) {
            diagnostics.push(...explicitAnyDiagnostics(sourceFile));
            diagnostics.push(...inferredAnyDiagnostics(sourceFile));
          }
        }
      }
      return diagnostics.sort(compareDiagnostics);
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

export function formatTypeScriptPolicyDiagnostic(diagnostic: TypeScriptPolicyDiagnostic): string {
  return `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [${diagnostic.kind}] ${diagnostic.message}`;
}
