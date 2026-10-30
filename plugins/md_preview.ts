/**
 * Команда «Markdown Preview»: открыть текущий .md в просмотрщике cmux
 * (`cmux markdown` — панель справа, обновляется при сохранении файла).
 *
 * Fresh без файла работает через фоновый сервер, а у него окружение того
 * терминала, где сервер запущен впервые: CMUX_WORKSPACE_ID/CMUX_SURFACE_ID
 * могут указывать на чужую вкладку. Без них cmux берёт вкладку в фокусе —
 * ту, где сейчас Fresh.
 */

const editor = getEditor();

const CMUX = "/Applications/cmux.app/Contents/Resources/bin/cmux";
const CALLER_ENV = ["CMUX_WORKSPACE_ID", "CMUX_SURFACE_ID", "CMUX_PANEL_ID", "CMUX_TAB_ID"];

async function md_preview(): Promise<void> {
  const path = editor.getBufferPath(editor.getActiveBufferId());
  if (!path || !/\.(md|markdown)$/i.test(path)) {
    editor.setStatus("Markdown Preview: текущий файл не .md");
    return;
  }
  const unset = CALLER_ENV.flatMap((name) => ["-u", name]);
  const result = await editor.spawnProcess("/usr/bin/env", [...unset, CMUX, "markdown", path]);
  if (result.exit_code !== 0) {
    editor.setStatus(`Markdown Preview: ${(result.stderr || result.stdout).trim()}`);
  }
}

registerHandler("md_preview", md_preview);
editor.registerCommand("Markdown Preview", "Открыть текущий .md в просмотрщике cmux", "md_preview");

editor.debug("md-preview: plugin loaded");
