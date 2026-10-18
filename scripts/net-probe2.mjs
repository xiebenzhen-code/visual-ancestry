import https from "node:https";
import crypto from "node:crypto";

function md5hex(s) {
  return crypto.createHash("md5").update(s).digest("hex");
}

function uploadUrlFromFilename(filename) {
  const md5 = md5hex(filename);
  return `https://upload.wikimedia.org/wikipedia/commons/${md5[0]}/${md5.slice(0, 2)}/${md5}/${encodeURIComponent(filename)}`;
}

const probes = [
  ["UPLOAD-SLASH", "Great Wave off Kanagawa2.jpg"],
  ["THUMB-HOST", "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a5/Great_Wave_off_Kanagawa2.jpg/200px-Great_Wave_off_Kanagawa2.jpg"],
];

for (const [name, arg] of probes) {
  const u = arg.startsWith("http") ? arg : uploadUrlFromFilename(arg);
  https
    .get(u, { rejectUnauthorized: false, headers: { "user-agent": "Mozilla/5.0 visual-ancestry-dev" } }, (r) => {
      let len = 0;
      const chunks = [];
      r.on("data", (c) => {
        len += c.length;
        if (chunks.length < 4) chunks.push(c);
      });
      r.on("end", () => {
        console.log(name, r.statusCode, "bytes=" + len, "finalHost=" + (r.req?.host || ""));
        nextPromise();
      });
    })
    .on("error", (e) => {
      console.log(name, "SOCKERR", e.message);
      nextPromise();
    })
    .setTimeout(20000, function () {
      console.log(name, "TIMEOUT");
      this.destroy();
      nextPromise();
    });
}

const jobs = probes.map(() => null);
function nextPromise() {
  jobs.push(1);
  if (jobs.filter((x) => x === 1).length >= 2) console.log("PROBE-DONE");
}