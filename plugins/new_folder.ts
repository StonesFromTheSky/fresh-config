/**
 * Команда «New Folder» в палитре: создать папку без проводника. Путь
 * считается от папки текущего файла (можно `../X`, `A/B` или абсолютный).
 * Новый файл в несуществующей папке плагин не нужен: на Ctrl+S Fresh сам
 * предлагает создать папку.
 */

const editor = getEditor();

const PROMPT = "new-folder";

let baseDir = "";

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i > 0 ? path.slice(0, i) : "/";
}

function relativeToCwd(path: string): string {
  const cwd = editor.getCwd();
  return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

function new_folder(): void {
  const path = editor.getBufferPath(editor.getActiveBufferId());
  baseDir = path ? parentDir(path) : editor.getCwd();
  editor.startPrompt(`New folder in ${relativeToCwd(baseDir)}/: `, PROMPT);
}

editor.on("prompt_confirmed", (data) => {
  if (data.prompt_type !== PROMPT) return;
  const input = data.input.trim().replace(/\/+$/, "");
  if (!input) return;
  const dir = input.startsWith("/") ? input : editor.pathJoin(baseDir, input);
  const shown = relativeToCwd(dir);
  if (editor.fileExists(dir)) {
    editor.setStatus(`Folder already exists: ${shown}`);
  } else if (editor.createDir(dir)) {
    editor.setStatus(`Folder created: ${shown}`);
  } else {
    editor.setStatus(`Could not create folder: ${shown}`);
  }
});

registerHandler("new_folder", new_folder);
editor.registerCommand("New Folder", "Create a folder (path relative to the current file's folder)", "new_folder");

editor.debug("new-folder: plugin loaded");
