// A minimal stand-in for the `vscode` module, enough for unit tests of the extension's glue.
export class Range {
  constructor(public startLine: number, public startChar: number, public endLine: number, public endChar: number) {}
}
export const Uri = { file: (path: string) => ({ fsPath: path, path }) };
export class MarkdownString {
  constructor(public value: string) {}
}
export enum CommentMode { Editing, Preview }
export enum CommentThreadCollapsibleState { Collapsed, Expanded }
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (l: (e: T) => void) => void this.listeners.push(l);
  fire(e: T) { this.listeners.forEach((l) => l(e)); }
}
export class TreeItem {
  constructor(public label: string, public collapsibleState?: number) {}
}
export enum TreeItemCollapsibleState { None, Collapsed, Expanded }
export const window = {};
export const workspace = { workspaceFolders: [] };
export const commands = {};
export const comments = {};
export enum ViewColumn { One = 1 }
export enum ProgressLocation { SourceControl = 1, Window = 10, Notification = 15 }
export enum StatusBarAlignment { Left = 1, Right = 2 }
