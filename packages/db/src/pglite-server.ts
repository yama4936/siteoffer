/**
 * PGlite を PostgreSQL のプロトコルで公開する、デモ用の小さなサーバー。
 *
 * @electric-sql/pglite-socket（packages/db/src/dev-server.ts が使う）は、複数の接続のメッセージを
 * 1メッセージずつ順に PGlite（1セッション）へ渡す。拡張問い合わせ（Parse/Bind/Execute/Sync）の途中に
 * 別の接続のメッセージが割り込むと、名前なしの文が上書きされたり、別の接続のトランザクションの中で
 * 実行されたりして、web・プレビュー・ワーカー（pg-boss）を同時に動かすと問い合わせが失敗した（2026-10-14 に確認）。
 *
 * ここでは次の単位で PGlite を1つの接続に専有させる：
 * - Sync（S）・単純問い合わせ（Q）・起動・パスワードまでのメッセージをまとめて1単位として実行する。
 * - 単位の実行後もトランザクション中なら、その接続が専有したままにする（COMMIT・ROLLBACK まで他の接続は待つ）。
 * - 専有中の接続が切れたら ROLLBACK して解放する。
 * 1セッションを順番に使うだけで、実PostgreSQLの同時実行（行ロックの競合など）の検証の代わりにはならない。
 */
import net from "node:net";

export interface PGliteLike {
  execProtocolRawStream(message: Uint8Array, options: { onRawData: (data: Uint8Array) => void }): Promise<void>;
  isInTransaction(): boolean;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const CANCEL_REQUEST = 80877102;
const PROTOCOL_V3 = 196608;

/** PGlite を1つの接続に専有させる錠。トランザクションをまたいで持ち続けられる */
class SessionLock {
  private owner: number | null = null;
  private waiters: { id: number; resolve: () => void }[] = [];

  async acquire(id: number): Promise<void> {
    if (this.owner === id) return;
    if (this.owner === null) {
      this.owner = id;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push({ id, resolve }));
  }

  release(id: number): void {
    if (this.owner !== id) return;
    const next = this.waiters.shift();
    this.owner = next ? next.id : null;
    next?.resolve();
  }

  /** 待っている接続を外す（接続が切れたとき） */
  forget(id: number): void {
    this.waiters = this.waiters.filter((w) => w.id !== id);
  }

  isOwner(id: number): boolean {
    return this.owner === id;
  }
}

export interface PGliteServer {
  stop(): Promise<void>;
}

export async function startPGliteServer(db: PGliteLike, opts: { port: number; host: string }): Promise<PGliteServer> {
  const lock = new SessionLock();
  const sockets = new Set<net.Socket>();
  let nextId = 1;

  const server = net.createServer((socket) => {
    const id = nextId++;
    sockets.add(socket);
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let started = false;
    let unit: Uint8Array[] = [];
    let chain: Promise<void> = Promise.resolve();
    let closed = false;

    const write = (data: Uint8Array) => {
      if (!closed && socket.writable && data.length > 0) socket.write(Buffer.from(data));
    };

    const runUnit = async (messages: Uint8Array[]) => {
      await lock.acquire(id);
      try {
        for (const m of messages) {
          if (closed) break;
          await db.execProtocolRawStream(m, { onRawData: write });
        }
      } finally {
        if (!db.isInTransaction() || closed) {
          if (closed && db.isInTransaction() && lock.isOwner(id)) await db.exec("ROLLBACK").catch(() => {});
          lock.release(id);
        }
      }
    };

    const enqueue = (messages: Uint8Array[]) => {
      chain = chain
        .then(() => runUnit(messages))
        .catch((e: unknown) => {
          console.error(`[db] 接続 #${id} の問い合わせに失敗：${(e as Error).message}`);
          socket.destroy();
        });
    };

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (!started) {
          if (buffer.length < 8) return;
          const len = buffer.readInt32BE(0);
          if (buffer.length < len) return;
          const code = buffer.readInt32BE(4);
          const msg = buffer.subarray(0, len);
          buffer = buffer.subarray(len);
          if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
            socket.write("N");
            continue;
          }
          if (code === CANCEL_REQUEST) {
            socket.end();
            return;
          }
          if (code !== PROTOCOL_V3) {
            socket.destroy();
            return;
          }
          started = true;
          enqueue([new Uint8Array(msg)]);
          continue;
        }
        if (buffer.length < 5) return;
        const type = String.fromCharCode(buffer[0]!);
        const len = 1 + buffer.readInt32BE(1);
        if (buffer.length < len) return;
        const msg = new Uint8Array(buffer.subarray(0, len));
        buffer = buffer.subarray(len);
        if (type === "X") {
          socket.end();
          return;
        }
        unit.push(msg);
        // 応答を待つ区切り（Sync・単純問い合わせ・パスワード・Flush）で1単位として実行する
        if (type === "S" || type === "Q" || type === "p" || type === "H") {
          const messages = unit;
          unit = [];
          enqueue(messages);
        }
      }
    });

    const onClose = () => {
      if (closed) return;
      closed = true;
      sockets.delete(socket);
      lock.forget(id);
      chain = chain.then(async () => {
        if (lock.isOwner(id)) {
          if (db.isInTransaction()) await db.exec("ROLLBACK").catch(() => {});
          lock.release(id);
        }
      });
    };
    socket.on("close", onClose);
    socket.on("error", onClose);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => resolve());
  });

  return {
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
