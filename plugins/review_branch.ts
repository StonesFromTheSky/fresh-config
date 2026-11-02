/**
 * Review Diff ветки от точки ответвления — то же, что покажет MR: изменения
 * ветки без чужих коммитов, появившихся в родительской ветке позже.
 *
 * Родитель ищется по числу коммитов (`git for-each-ref
 * --format=%(ahead-behind:HEAD)`, git ≥ 2.41): ближайшая из остальных веток,
 * локальных и remote, — та, относительно которой у текущей меньше всего
 * своих коммитов. Ветки, которые уже содержат HEAD (влившие её или созданные
 * от её вершины), и сама ветка с её remote-копией (то же имя) не в счёт.
 * Diff зависит только от точки ответвления (merge-base), поэтому ветки с одной
 * и той же точкой — один вариант; первой в нём стоит та, что ушла от этой
 * точки меньше других.
 *
 * Встроенный Review Diff: Range для `A...B` всё равно строит `git diff A..B`
 * (вершина против вершины), поэтому в Range уходит `<merge-base>..HEAD`.
 * Открывается промпт Range с найденной точкой; Enter — открыть, ↑/↓ —
 * другие варианты. Его обрабатывает audit_mode (prompt_confirmed с типом
 * review-range), хук рассылается всем плагинам.
 *
 * Каждый вызов git из плагина — круг через цикл редактора, 0,1–0,2 с
 * независимо от самого git. Поэтому вызовов два «слоя», внутри слоя —
 * параллельно: список веток, затем merge-base.
 *
 * Незакоммиченные правки сюда не входят — они в обычном Review Diff.
 */

const editor = getEditor();

/** Сколько ближайших коммитов-вершин проверять и сколько вариантов показать. */
const MAX_TIPS = 15;
const MAX_CHOICES = 6;

interface Candidate {
  name: string; // origin/release/1.2
  plain: string; // release/1.2 — без имени remote
  sha: string; // вершина ветки
  ahead: number; // коммитов в ветке, которых нет в HEAD
  behind: number; // коммитов в HEAD, которых нет в ветке
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  const r = await editor.spawnProcess("git", args, cwd);
  return r.exit_code === 0 ? r.stdout.trim() : null;
}

// Тот же каталог, от которого audit_mode ищет репозиторий: папка активного
// файла, иначе рабочий каталог редактора. git работает и из подпапки.
function startDir(): string {
  const path = editor.getBufferPath(editor.getActiveBufferId());
  return (path && editor.pathDirname(path)) || editor.getCwd();
}

async function review_branch(): Promise<void> {
  const cwd = startDir();
  // %(HEAD) — последним полем: git() срезает пробелы по краям вывода.
  const [listing, remoteList] = await Promise.all([
    git(cwd, [
      "for-each-ref",
      "--format=%(refname)%09%(refname:short)%09%(objectname)%09%(ahead-behind:HEAD)%09%(HEAD)",
      "refs/heads",
      "refs/remotes",
    ]),
    git(cwd, ["remote"]),
  ]);
  if (listing === null) {
    editor.setStatus("Review Branch: not a git repository (or git older than 2.41)");
    return;
  }
  const remotes = new Set((remoteList ?? "").split("\n").filter(Boolean));
  const rows = listing.split("\n").map((line) => line.split("\t"));
  const branch = rows.find((r) => r[4] === "*")?.[1] ?? null; // null — detached HEAD

  const candidates: Candidate[] = [];
  for (const [full, name, sha, counts] of rows) {
    if (!full || !counts) continue;
    const [ahead, behind] = counts.split(" ").map(Number);
    const slash = name.indexOf("/");
    const plain =
      full.startsWith("refs/remotes/") && slash > 0 && remotes.has(name.slice(0, slash)) ? name.slice(slash + 1) : name;
    // refs/remotes/origin/HEAD — ссылка на ветку по умолчанию, не ветка
    if (full.endsWith("/HEAD") || behind === 0) continue;
    // Своя копия на remote — не родитель. Upstream с другим именем не
    // исключаем: при `checkout -b hotfix/x origin/release/1.2` он и есть родитель.
    if (branch && plain === branch) continue;
    candidates.push({ name, plain, sha, ahead, behind });
  }
  if (candidates.length === 0) {
    editor.setStatus("Review Branch: no other branch to compare with");
    return;
  }
  candidates.sort((a, b) => a.behind - b.behind || a.ahead - b.ahead || a.name.localeCompare(b.name));

  // merge-base считается по вершине: develop и origin/develop на одном
  // коммите — один вызов.
  const tips = [...new Set(candidates.map((c) => c.sha))].slice(0, MAX_TIPS);
  const bases = await Promise.all(tips.map((sha) => git(cwd, ["merge-base", sha, "HEAD"])));
  const forkOf = new Map(tips.map((sha, i) => [sha, bases[i]]));

  // Ближайшие ветки, сгруппированные по точке ответвления.
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const fork = forkOf.get(c.sha);
    if (!fork) continue;
    const group = groups.get(fork) ?? [];
    if (!group.some((g) => g.plain === c.plain)) group.push(c);
    groups.set(fork, group);
  }
  const forks = [...groups.keys()].slice(0, MAX_CHOICES);
  if (forks.length === 0) {
    editor.setStatus("Review Branch: no common ancestor with other branches");
    return;
  }

  const suggestions: PromptSuggestion[] = forks.map((fork) => {
    const group = groups.get(fork)!;
    // Десяти знаков SHA хватает для однозначности; `rev-parse --short`
    // стоил бы ещё одного круга.
    const short = fork.slice(0, 10);
    const others = group.slice(1, 3).map((c) => c.name);
    const more = group.length > 3 ? ` +${group.length - 3}` : "";
    const commits = group[0].behind === 1 ? "1 commit" : `${group[0].behind} commits`;
    return {
      id: fork,
      text: group[0].name,
      description: `fork ${short} · ${commits}${others.length ? ` · also ${others.join(", ")}${more}` : ""}`,
      value: `${short}..HEAD`,
    };
  });
  editor.startPromptWithInitial(
    `Review since fork from ${suggestions[0].text} (↑↓ other base):`,
    "review-range",
    suggestions[0].value!,
  );
  editor.setPromptSuggestions(suggestions);
}

registerHandler("review_branch", review_branch);
editor.registerCommand(
  "Review Diff: Branch Since Fork",
  "Changes on the current branch since it forked from its parent branch (as in a merge request)",
  "review_branch",
);

editor.debug("review-branch: plugin loaded");
