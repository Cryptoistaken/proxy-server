import http from "http";

const TCP_HOST = "kodama.proxy.rlwy.net";
const TCP_PORT = 11055;
const PROXY_AUTH = "ratul:ratul";
const B64_AUTH = Buffer.from(PROXY_AUTH).toString("base64");

const targets = [
  "http://neverssl.com/",
  "http://example.com/",
  "http://httpbin.org/get",
  "http://httpforever.com/",
];

let passed = 0;
let failed = 0;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function testTarget(target) {
  return new Promise((resolve) => {
    console.log(`\n→ ${target}`);

    const start = Date.now();
    const req = http.request({
      hostname: TCP_HOST,
      port: TCP_PORT,
      method: "GET",
      path: target,
      headers: {
        Host: new URL(target).hostname,
        "Proxy-Authorization": "Basic " + B64_AUTH,
      },
    });

    req.on("response", (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        const ms = Date.now() - start;
        console.log(`  Status: ${res.statusCode}  (${ms}ms)`);
        if (res.statusCode < 400) passed++;
        else failed++;
        resolve();
      });
    });

    req.on("error", (err) => {
      const ms = Date.now() - start;
      console.log(`  Error: ${err.code || "?"} — ${err.message || "(no message)"}  (${ms}ms)`);
      failed++;
      resolve();
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error("TIMEOUT"));
    });

    req.end();
  });
}

console.log("Proxy Connectivity Test");
console.log(`TCP Proxy: ${PROXY_AUTH}@${TCP_HOST}:${TCP_PORT}\n`);

(async () => {
  for (const target of targets) {
    await testTarget(target);
    await sleep(500);
  }

  const total = passed + failed;
  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed}/${total} passed`);
})();
