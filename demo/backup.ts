import path from "node:path";
import readline from "node:readline";
import { BackupError, ensurePlainDirectory } from "./backup/bundle.ts";
import { requestControl } from "./backup/control.ts";
import { unlockStoppedOwner } from "./backup/owner.ts";
import { pgliteRuntime } from "./backup/runtime.ts";
import { restoreSnapshot } from "./backup/snapshot.ts";
import { DEMO_PATHS } from "./paths.ts";

async function promptPassword(label: string) {
  const configured = process.env.SITEOFFER_BACKUP_PASSPHRASE;
  if (configured) return configured;
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new BackupError(
      "対話端末から実行するか、SITEOFFER_BACKUP_PASSPHRASEを設定してください。パスフレーズを引数には書かないでください。",
    );
  process.stdout.write(label);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let input = "";
    const done = (error?: Error) => {
      process.stdin.off("keypress", pressed);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(input);
    };
    const pressed = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === "c") done(new BackupError("中断しました。"));
      else if (key.name === "return") done();
      else if (key.name === "backspace") {
        if (input) {
          input = Array.from(input).slice(0, -1).join("");
          process.stdout.write("\b \b");
        }
      } else if (text && !key.ctrl && input.length < 1024) {
        input += text;
        process.stdout.write("*".repeat(Array.from(text).length));
      }
    };
    process.stdin.on("keypress", pressed);
  });
}
async function main() {
  const command = process.argv[2];
  if (command === "unlock") {
    await unlockStoppedOwner(DEMO_PATHS.data);
    console.log("停止済みの利用記録を解除しました。データは変更していません。");
    return;
  }
  if (command === "stop") {
    await requestControl(DEMO_PATHS.data, "stop");
    console.log("正常停止を依頼しました。終了まで数秒お待ちください。");
    return;
  }
  if (command !== "create" && command !== "restore")
    throw new BackupError("pnpm demo:backup / demo:restore <ファイル> / demo:stop / demo:unlock を使ってください。");
  if ((command === "create" && process.argv.length !== 3) || (command === "restore" && process.argv.length !== 4))
    throw new BackupError("パスフレーズは引数に含めず、確認画面で入力してください。");
  let password = await promptPassword(
    command === "restore" ? "保存時のパスフレーズ: " : "保存用パスフレーズ（12文字以上）: ",
  );
  try {
    if (command === "create") {
      if (!process.env.SITEOFFER_BACKUP_PASSPHRASE && password !== (await promptPassword("確認のため再入力: ")))
        throw new BackupError("パスフレーズが一致しません。");
      let previous = "";
      const result = await requestControl(DEMO_PATHS.data, "backup", password, (value) => {
        if (value.phase !== previous) {
          previous = value.phase;
          console.log(
            (
              {
                snapshot: "DBの保存状態を取得しています…",
                files: "成果物を照合しています…",
                encrypt: "暗号化して保存しています…",
                verify: "隔離した復元データを照合しています…",
              } as Record<string, string>
            )[value.phase] ?? "確認中…",
          );
        }
      });
      console.log(
        `暗号化バックアップを保存し、復元を確認しました: ${result.file}\n${result.files}ファイル / ${result.bytes}バイト`,
      );
    } else {
      const { PGlite, version: engineVersion } = pgliteRuntime();
      await ensurePlainDirectory(DEMO_PATHS.restores);
      console.log("新しい隔離フォルダーへ復元・照合しています…");
      const result = await restoreSnapshot({
        file: path.resolve(process.argv[3]!),
        restoreRoot: DEMO_PATHS.restores,
        password,
        engineVersion,
        create: (dataDir, loadDataDir) => PGlite.create({ dataDir, loadDataDir }),
      });
      console.log(
        `復元データ: ${result.directory}\n${result.files}ファイル・${result.references}件の成果物参照を照合しました。稼働中のデータは変更していません。`,
      );
    }
  } finally {
    password = "";
  }
}
main().catch((error) => {
  console.error(
    error instanceof BackupError ? error.message : "処理に失敗しました。データの利用状態と保存先を確認してください。",
  );
  process.exitCode = 1;
});
