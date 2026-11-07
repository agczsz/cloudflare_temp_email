// debug SMTP sink capturing messages for relay tests
import { SMTPServer } from "smtp-server";
import fs from "node:fs";
const srv = new SMTPServer({
  authOptional: true,
  disabledCommands: ["STARTTLS"],
  onData(stream, session, cb) {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => {
      fs.appendFileSync("sink_capture.eml", Buffer.concat(chunks));
      cb();
    });
  },
});
srv.on("error", (e) => console.error("sink error", e));
srv.listen(2526, "127.0.0.1", () => console.log("sink on 2526"));
