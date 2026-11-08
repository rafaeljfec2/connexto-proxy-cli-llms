import http from "node:http";
import { BrowserSessionManager, ChromeLauncher } from "../src/index.js";
async function checkCdpEndpoint(port, host = "127.0.0.1") {
    return new Promise((resolve) => {
        const req = http.get({ host, port, path: "/json/version", timeout: 2000 }, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk.toString();
            });
            res.on("end", () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({ ok: res.statusCode === 200, data: parsed });
                }
                catch {
                    resolve({ ok: false, error: "Failed to parse JSON" });
                }
            });
        });
        req.on("error", (err) => resolve({ ok: false, error: err.message, code: err.code }));
        req.on("timeout", () => {
            req.destroy();
            resolve({ ok: false, error: "timeout" });
        });
    });
}
async function run() {
    console.log("=== INITIATING REAL WINDOWS HOST CHROME VERIFICATION ===");
    console.log("Platform:", process.platform, "Node version:", process.version);
    const launcher = new ChromeLauncher();
    const chromePath = launcher.resolveChromeExecutable();
    console.log("Resolved Chrome executable:", chromePath);
    const manager = new BrowserSessionManager({
        launcher,
        cleanupProfileOnClose: true,
    });
    console.log("\n[Step 1] Creating Session 1 (Alice)...");
    const session1 = await manager.createSession({
        principalId: "user-alice",
        target: "test-target-1",
        targetUrl: "about:blank",
        headless: false,
    });
    console.log("Session 1 Created:", {
        id: session1.id,
        pid: session1.processId,
        port: session1.cdpPort,
        profile: session1.userDataDir,
    });
    console.log("\n[Step 2] Creating Session 2 (Bob)...");
    const session2 = await manager.createSession({
        principalId: "user-bob",
        target: "test-target-2",
        targetUrl: "about:blank",
        headless: false,
    });
    console.log("Session 2 Created:", {
        id: session2.id,
        pid: session2.processId,
        port: session2.cdpPort,
        profile: session2.userDataDir,
    });
    // Verification 1: Distinct processes, ports, directories
    console.log("\n[Step 3] Verifying Isolation between Session 1 and Session 2...");
    if (session1.id === session2.id) {
        throw new Error("FAIL: Session IDs must be distinct");
    }
    if (session1.processId === session2.processId) {
        throw new Error("FAIL: PIDs must be distinct");
    }
    if (session1.cdpPort === session2.cdpPort) {
        throw new Error("FAIL: CDP Ports must be distinct");
    }
    if (session1.userDataDir === session2.userDataDir) {
        throw new Error("FAIL: Profiles must be distinct");
    }
    console.log("PASS: Sessions have distinct IDs, PIDs, Ports, and Profile directories.");
    // Verification 2: CDP is alive on 127.0.0.1 for both
    console.log("\n[Step 4] Querying CDP endpoints on loopback (127.0.0.1)...");
    const cdp1 = await checkCdpEndpoint(session1.cdpPort);
    console.log("Session 1 CDP 127.0.0.1:", cdp1.ok
        ? `ONLINE (${cdp1.data?.Browser ?? "unknown"})`
        : `OFFLINE: ${cdp1.error ?? "unknown"}`);
    if (!cdp1.ok) {
        throw new Error("FAIL: Session 1 CDP not responding on 127.0.0.1");
    }
    const cdp2 = await checkCdpEndpoint(session2.cdpPort);
    console.log("Session 2 CDP 127.0.0.1:", cdp2.ok
        ? `ONLINE (${cdp2.data?.Browser ?? "unknown"})`
        : `OFFLINE: ${cdp2.error ?? "unknown"}`);
    if (!cdp2.ok) {
        throw new Error("FAIL: Session 2 CDP not responding on 127.0.0.1");
    }
    // Verification 3: CDP is NOT exposed on external interfaces (e.g. 192.168.100.64)
    console.log("\n[Step 5] Verifying CDP loopback restriction (external interface should reject)...");
    const extCheck1 = await checkCdpEndpoint(session1.cdpPort, "192.168.100.64");
    console.log("Session 1 CDP on 192.168.100.64:", extCheck1.ok
        ? "EXPOSED (SECURITY RISK)"
        : `REJECTED (${extCheck1.code ?? extCheck1.error ?? "unknown"})`);
    if (extCheck1.ok) {
        throw new Error("FAIL: CDP is exposed on external IP!");
    }
    console.log("PASS: CDP is strictly bound to 127.0.0.1 and rejected on external IP.");
    // Verification 4: Close Session 1, verify Session 2 remains unaffected
    console.log("\n[Step 6] Closing Session 1 (Alice)...");
    await manager.closeSession(session1.id, "user-alice");
    console.log("Session 1 closed.");
    // Check Session 1 is dead
    const cdp1After = await checkCdpEndpoint(session1.cdpPort);
    console.log("Session 1 CDP after close:", cdp1After.ok
        ? "STILL ALIVE (FAIL)"
        : `TERMINATED (${cdp1After.code ?? "unknown"})`);
    if (cdp1After.ok) {
        throw new Error("FAIL: Session 1 remained alive after close");
    }
    // Check Session 2 is STILL online
    const cdp2After = await checkCdpEndpoint(session2.cdpPort);
    console.log("Session 2 CDP after Session 1 closed:", cdp2After.ok
        ? "ONLINE (ISOLATION VERIFIED)"
        : "DEAD (FAIL)");
    if (!cdp2After.ok) {
        throw new Error("FAIL: Session 2 died when Session 1 was closed!");
    }
    const session2Status = manager.getSession(session2.id, "user-bob");
    console.log("Session 2 status in manager:", session2Status.status);
    if (session2Status.status !== "waiting_for_login") {
        throw new Error("FAIL: Session 2 status altered");
    }
    // Verification 5: Close Session 2
    console.log("\n[Step 7] Closing Session 2 (Bob)...");
    await manager.closeSession(session2.id, "user-bob");
    console.log("Session 2 closed.");
    const cdp2Final = await checkCdpEndpoint(session2.cdpPort);
    console.log("Session 2 CDP after close:", cdp2Final.ok
        ? "STILL ALIVE (FAIL)"
        : `TERMINATED (${cdp2Final.code ?? "unknown"})`);
    if (cdp2Final.ok) {
        throw new Error("FAIL: Session 2 remained alive after close");
    }
    console.log("Active sessions remaining:", manager.activeSessionsCount);
    if (manager.activeSessionsCount !== 0) {
        throw new Error("FAIL: Expected 0 active sessions");
    }
    console.log("\n=== REAL WINDOWS HOST CHROME VERIFICATION COMPLETED SUCCESSFULLY ===");
}
run().catch((err) => {
    console.error("FATAL VERIFICATION ERROR:", err);
    process.exit(1);
});
//# sourceMappingURL=real-windows-verification.js.map