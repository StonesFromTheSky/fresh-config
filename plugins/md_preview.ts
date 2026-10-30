/**
 * Команда «Markdown Preview»: открыть текущий .md в просмотрщике cmux
 * (`cmux markdown` — панель справа, обновляется при изменении файла на диске).
 *
 * Просмотрщик читает только диск, поэтому после открытия превью буфер
 * сохраняется сам — через SAVE_PAUSE_MS после последней правки и до закрытия
 * вкладки. Ctrl+S не нужен, undo работает как обычно.
 *
 * Fresh без файла работает через фоновый сервер, а у него окружение того
 * терминала, где сервер запущен впервые: CMUX_WORKSPACE_ID/CMUX_SURFACE_ID
 * могут указывать на чужую вкладку. Без них cmux берёт вкладку в фокусе —
 * ту, где сейчас Fresh.
 */

const editor = getEditor();

const CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const CALLER_ENV = ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_PANEL_ID", "CMUX_TAB_ID"];
const SAVE_PAUSE_MS = 300;

/** Буферы с открытым превью: id → путь файла. */
const liveBuffers = new Map<number, string>();
let saveTimer: number | null = null;

function md_preview_save(): void {
  saveTimer = null;
  for (const [bufferId, path] of liveBuffers) {
    if (editor.isBufferModified(bufferId)) editor.saveBufferToPath(bufferId, path);
  }
}

async function md_preview(): Promise<void> {
  const bufferId = editor.getActiveBufferId();
  const path = editor.getBufferPath(bufferId);
  if (!path || !/\.(md|markdown)$/i.test(path)) {
    editor.setStatus("Markdown Preview: текущий файл не .md");
    return;
  }
  // Превью должно сразу показать то, что в буфере, а не на диске
  if (editor.isBufferModified(bufferId)) editor.saveBufferToPath(bufferId, path);
  const unset = CALLER_ENV.flatMap((name) => ["-u", name]);
  const result = await editor.spawnProcess("/usr/bin/env", [...unset, CMUX, "markdown", path]);
  if (result.exit_code !== 0) {
    editor.setStatus(`Markdown Preview: ${(result.stderr || result.stdout).trim()}`);
    return;
  }
  liveBuffers.set(bufferId, path);
}

editor.on("buffer_modified", (data) => {
  if (!liveBuffers.has(data.buffer_id)) return;
  if (saveTimer !== null) editor.clearInterval(saveTimer);
  saveTimer = editor.setTimeout(SAVE_PAUSE_MS, "md_preview_save");
});

editor.on("buffer_closed", (data) => {
  liveBuffers.delete(data.buffer_id);
});

registerHandler("md_preview", md_preview);
registerHandler("md_preview_save", md_preview_save);
editor.registerCommand("Markdown Preview", "Открыть текущий .md в просмотрщике cmux", "md_preview");

editor.debug("md-preview: plugin loaded");
