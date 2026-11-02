/**
 * Декомпилированные исходники для перехода к определению в C#.
 *
 * csharp-ls с `--features metadata-uris` отвечает на go-to-definition по
 * символам из сборок (NuGet, BCL) виртуальным URI
 * `csharp:/<project.csproj>/decompiled/<Symbol>.cs`. Ядро Fresh такие URI
 * открыть не может, поэтому плагин:
 *   1. забирает схему `csharp` через registerLspUriScheme;
 *   2. на хуке `lsp_open_external_uri` запрашивает текст запросом
 *      `csharp/metadata` (ILSpy внутри csharp-ls);
 *   3. кладёт его во временный файл и открывает read-only на нужной позиции.
 *
 * Сделано по образцу встроенного плагина slang-lsp.
 */

const editor = getEditor();

const SCHEME = "csharp";

interface LspOpenExternalUriData {
  uri: string;
  scheme: string;
  line: number; // 0-indexed (LSP)
  character: number; // 0-indexed (LSP)
  language: string;
  server_name: string;
}

interface CSharpMetadata {
  projectName?: string;
  assemblyName?: string;
  symbolName?: string;
  source?: string;
}

/** `csharp:/…/decompiled/System.Threading.Tasks.Task%601.cs` → `System.Threading.Tasks.Task`1.cs` */
function fileNameFromUri(uri: string): string {
  const last = uri.split("/").pop() || "Decompiled.cs";
  let name = last;
  try {
    name = decodeURIComponent(last);
  } catch (_e) {
    // оставляем как есть
  }
  return name.endsWith(".cs") ? name : `${name}.cs`;
}

editor.registerLspUriScheme(SCHEME);

editor.on("lsp_open_external_uri", async (data: LspOpenExternalUriData) => {
  if (data.scheme !== SCHEME) return;

  if (editor.getAuthorityLabel() !== "") {
    editor.setStatus("csharp-decompiled: only local sessions are supported");
    return;
  }

  editor.setStatus("csharp-decompiled: decompiling…");
  let meta: CSharpMetadata | null = null;
  try {
    meta = (await editor.sendLspRequest(data.language || "csharp", "csharp/metadata", {
      textDocument: { uri: data.uri },
    })) as CSharpMetadata | null;
  } catch (e) {
    editor.setStatus(`csharp-decompiled: csharp/metadata failed: ${e}`);
    return;
  }
  if (!meta || typeof meta.source !== "string") {
    editor.setStatus(`csharp-decompiled: the server returned no source for ${data.uri}`);
    return;
  }

  const dir = `${editor.getTempDir()}/fresh-csharp-decompiled/${meta.assemblyName || "unknown"}`;
  editor.createDir(editor.localPath(dir));
  const path = `${dir}/${fileNameFromUri(data.uri)}`;
  if (!editor.writeFile(editor.localPath(path), meta.source)) {
    editor.setStatus(`csharp-decompiled: could not write ${path}`);
    return;
  }

  // LSP-позиции с 0, openFile — с 1.
  if (!editor.openFile(path, data.line + 1, data.character + 1)) {
    editor.setStatus(`csharp-decompiled: could not open ${path}`);
    return;
  }
  editor.markFileReadOnly(path);
  editor.setStatus(`${meta.symbolName || "symbol"} — ${meta.assemblyName || "assembly"} (decompiled)`);
});

editor.debug("csharp-decompiled: plugin loaded");
