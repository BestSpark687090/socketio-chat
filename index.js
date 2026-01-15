import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Server } from "socket.io";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";

if (cluster.isPrimary) {
  for (let i = 0; i < 1; i++) {
    cluster.fork({
      PORT: 3000 + i,
    });
  }

  setupPrimary();
} else {
  const db = await open({
    filename: "chat.db",
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_offset TEXT UNIQUE,
      username TEXT,
      content TEXT
    );
  `);

  const app = express();
  const server = createServer(app);
  const io = new Server(server, {
    connectionStateRecovery: {},
    adapter: createAdapter(),
  });

  const __dirname = dirname(fileURLToPath(import.meta.url));

  app.get("/", (req, res) => {
    res.sendFile(join(__dirname, "index.html"));
  });
  io.on("connection", async (socket) => {
    socket.on("delete chat message", async (clientOffset, deleteCode) => {
      try {
        // check if ts even exists
        const check = await db.get(
          "SELECT * FROM messages WHERE id = ?",
          clientOffset
        );
        if (!check) {
          return;
        }
        if (deleteCode == "bestspark") {
          console.log(
            "correct code, attempting deletion on message",
            clientOffset
          );
          let result = await db.run(
            `DELETE FROM messages WHERE id = ?`,
            clientOffset
          );
          // console.log("after deletion, testing");
          io.emit("delete chat message", clientOffset);
        } else {
          console.log("wrong delete code, got", deleteCode);
        }
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          console.log(e);
          // callback();
        } else {
          console.log(e);
          // nothing to do, just let the client retry
        }
      }
    });
    socket.on("chat message", async (msg, clientOffset, username, callback) => {
      let result;
      try {
        result = await db.run(
          "INSERT INTO messages (content, client_offset, username) VALUES (?, ?, ?)",
          msg,
          clientOffset,
          username
        );
      } catch (e) {
        if (e.errno === 19 /* SQLITE_CONSTRAINT */) {
          callback();
        } else {
          console.log(e);
          // nothing to do, just let the client retry
        }
        return;
      }
      console.log(result.lastID);
      io.emit("chat message", msg, result.lastID, username);
      callback();
    });

    if (!socket.recovered) {
      try {
        await db.each(
          "SELECT id, content, username FROM messages WHERE id > ?",
          [socket.handshake.auth.serverOffset || 0],
          (_err, row) => {
            socket.emit("chat message", row.content, row.id, row.username);
          }
        );
      } catch (e) {
        console.log(e);
        // something went wrong
      }
    }
  });

  const port = process.env.PORT;

  server.listen(port, () => {
    console.log(`server running at http://localhost:${port}`);
  });
}
