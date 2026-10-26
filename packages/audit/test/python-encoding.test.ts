import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { createPythonRunner } from "../src/python.ts";
import { parseDecideOutput } from "../src/scripts.ts";

it("実Pythonの標準出力・標準エラー・引数・ファイルが、ホストの文字コード設定に左右されない", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "siteoffer-unicode-"));
  const cleanupTarget = path.resolve(dir);
  if (
    path.dirname(cleanupTarget) !== path.resolve(os.tmpdir()) ||
    !path.basename(cleanupTarget).startsWith("siteoffer-unicode-")
  )
    throw Error("Unexpected test cleanup path");
  try {
    const script = path.join(dir, "日本語の判定_𠮷😀.py"),
      file = path.join(dir, "保存結果_𠮷😀.txt"),
      text = "閾値が未設定。𠮷野 👩‍💻 e\u0301 半角ｶﾅ 全角１２３";
    await writeFile(
      script,
      "import json,sys\nfrom pathlib import Path\ntext=sys.argv[1]\nPath(sys.argv[2]).write_text(text,encoding='utf-8')\nsys.stdout.write(json.dumps({'decision':'pending','reasons':[text],'encoding':sys.stdout.encoding},ensure_ascii=False))\nsys.stderr.write(text)\n",
      "utf8",
    );
    const result = await createPythonRunner().run(script, [text, file], {
      cwd: dir,
      timeoutMs: 10_000,
      extraEnv: { LANG: "C", LC_ALL: "C", PYTHONUTF8: "0", PYTHONIOENCODING: "cp932" },
    });
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stderr: text });
    expect(JSON.parse(result.stdout).encoding.replaceAll("-", "").toLowerCase()).toBe("utf8");
    expect(parseDecideOutput(result.stdout)).toMatchObject({ ok: true, value: { decision: "hold", reasons: [text] } });
    expect(await readFile(file, "utf8")).toBe(text);
  } finally {
    await rm(cleanupTarget, { recursive: true, force: true });
  }
});
