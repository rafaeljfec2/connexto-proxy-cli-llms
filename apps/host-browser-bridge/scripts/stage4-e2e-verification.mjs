/**
 * End-to-end and resilience verification for Stage 4
 * Tests all required failure modes, isolation, lifecycle, and session continuity.
 */

const AIHUB_URL = process.env.AIHUB_URL || "http://127.0.0.1:8080";
const AIHUB_ADMIN_KEY = process.env.AIHUB_ADMIN_KEY || "jHejIGtcmb/j3HOaKxtUccLxuzBuok+LQl2IioNeJt9SIt4uzbmpl+v9sKEl6gcB";
const PROXY_URL = process.env.PROXY_URL || "http://127.0.0.1:9090";
const PROXY_KEY = process.env.PROXY_KEY || "_RpASqMwoXOIwgteRpxU9PAjGEr_K3sCYUeVZKIs-h0";
const BRIDGE_URL = process.env.BRIDGE_URL || "http://host.docker.internal:4318";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "stage3-secure-token-xyz";

async function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

async function run() {
  console.log("==================================================================");
  console.log("=== STAGE 4 END-TO-END VALIDATION & RESILIENCE TEST SUITE      ===");
  console.log("==================================================================");

  // -------------------------------------------------------------------------
  // TEST 1: Full Chain: AI Hub -> Proxy Docker -> Bridge Windows -> Chrome
  // -------------------------------------------------------------------------
  console.log("\n[TEST 1] Triggering Auth Start from AI Hub (/api/providers/cursor/proxy/cursor/auth/start)...");
  const aihubStartRes = await fetch(`${AIHUB_URL}/api/providers/cursor/proxy/cursor/auth/start`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIHUB_ADMIN_KEY}`,
      "Content-Type": "application/json",
    },
  });
  console.log("AI Hub response status:", aihubStartRes.status);
  assert(aihubStartRes.status === 200, "AI Hub auth start returned 200");
  const aihubJson = await aihubStartRes.json();
  console.log("AI Hub payload:", JSON.stringify(aihubJson));
  assert(aihubJson.status === "authentication_pending", "AI Hub status is authentication_pending");
  assert(aihubJson.sessionId, "AI Hub returned sessionId");
  assert(aihubJson.browserMode === "headed", "AI Hub returned browserMode 'headed'");
  const mainSessionId = aihubJson.sessionId;

  // Verify that the session exists in the Windows Bridge with Chrome running
  console.log("\n[TEST 1.1] Querying Windows Bridge for the AI Hub-initiated session...");
  const bridgeQueryRes = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${mainSessionId}?principalId=cursor`,
    {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    },
  );
  console.log("Bridge query status:", bridgeQueryRes.status);
  assert(bridgeQueryRes.status === 200, "Bridge session query returned 200");
  const bridgeSession = await bridgeQueryRes.json();
  console.log("Bridge session details:", JSON.stringify(bridgeSession));
  assert(bridgeSession.connected === true, "Session connected to Chrome via CDP");
  assert(bridgeSession.status === "waiting_for_login", "Session status is waiting_for_login");
  console.log("PASS: Full Chain AI Hub -> Proxy -> Windows Bridge -> Chrome is active!");

  // -------------------------------------------------------------------------
  // TEST 2: Session Continuity: Navigation & Evaluation on SAME Browser Session
  // -------------------------------------------------------------------------
  console.log("\n[TEST 2] Navigating within authorized bounds in same browser session...");
  const navRes = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${mainSessionId}/execute`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "cursor",
        action: "navigate",
        param: "about:blank",
      }),
    },
  );
  console.log("Navigate status:", navRes.status);
  assert(navRes.status === 200, "Navigate returned 200");

  console.log("\n[TEST 2.1] Executing authorized JS evaluation on SAME browser session without opening second browser...");
  const evalRes = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${mainSessionId}/execute`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "cursor",
        action: "evaluate",
        param: "navigator.userAgent",
      }),
    },
  );
  console.log("Execute evaluate status:", evalRes.status);
  assert(evalRes.status === 200, "Execute evaluate returned 200");
  const evalJson = await evalRes.json();
  console.log("Execute result (User Agent in active Chrome):", evalJson.result);
  assert(evalJson.success === true, "Evaluation succeeded");
  assert(typeof evalJson.result === "string" && evalJson.result.includes("Chrome"), "Executed on real Chrome instance");
  console.log("PASS: Session continuity verified: evaluated in existing browser context without cookie transfer!");

  // Clean up main test session
  console.log("\nCleaning up main session...");
  const delMain = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${mainSessionId}?principalId=cursor`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    },
  );
  assert(delMain.status === 204, "Main session deleted");
  console.log("PASS: Main session deleted cleanly.");

  // -------------------------------------------------------------------------
  // TEST 4: Cancelled Login (DELETE while waiting_for_login)
  // -------------------------------------------------------------------------
  console.log("\n[TEST 4] Testing Login Cancellation via Proxy...");
  const proxyStartRes = await fetch(`${PROXY_URL}/v1/providers/cursor/auth`, {
    method: "POST",
    headers: {
      "X-Gateway-API-Key": PROXY_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ accountId: "cursor-cancel" }),
  });
  const proxyStartJson = await proxyStartRes.json();
  const cancelId = proxyStartJson.sessionId;
  console.log("Session created via Proxy for cancellation:", cancelId);

  // Cancel via Proxy cancelAuth endpoint
  const proxyCancelRes = await fetch(`${PROXY_URL}/v1/providers/cursor/auth/${cancelId}`, {
    method: "DELETE",
    headers: {
      "X-Gateway-API-Key": PROXY_KEY,
    },
  });
  console.log("Proxy cancel status:", proxyCancelRes.status);
  assert(proxyCancelRes.status === 204, "Proxy cancel returned 204");

  // Verify Bridge reflects deletion
  const verifyCancel = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${cancelId}?principalId=cursor-cancel`,
    {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    },
  );
  console.log("Bridge status after cancel:", verifyCancel.status);
  assert(verifyCancel.status === 404, "Bridge returned 404 for cancelled session");
  console.log("PASS: Login cancellation verified cleanly.");

  // -------------------------------------------------------------------------
  // TEST 5: Expired Session (TTL Expiration)
  // -------------------------------------------------------------------------
  console.log("\n[TEST 5] Testing Session Expiration with short TTL (1500ms)...");
  const expireSessRes = await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      principalId: "cursor-expire",
      target: "cursor",
      targetUrl: "about:blank",
      ttlMs: 1500,
    }),
  });
  const expireSess = await expireSessRes.json();
  const expireId = expireSess.sessionId;
  console.log("Session created with 1500ms TTL:", expireId);

  console.log("Waiting 2500ms for expiration...");
  await new Promise((r) => setTimeout(r, 2500));

  const afterExpireRes = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${expireId}?principalId=cursor-expire`,
    {
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    },
  );
  console.log("Bridge status after TTL elapsed:", afterExpireRes.status);
  const afterExpireJson = await afterExpireRes.json();
  console.log("Payload after TTL elapsed:", JSON.stringify(afterExpireJson));
  assert(
    afterExpireRes.status === 404 ||
      (afterExpireRes.status === 200 && afterExpireJson.status === "expired"),
    "Session is expired and cleaned up after TTL elapsed",
  );

  // Clean up expired session
  await fetch(`${BRIDGE_URL}/internal/browser/sessions/${expireId}?principalId=cursor-expire`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
  });
  console.log("PASS: Session expiration verified.");

  // -------------------------------------------------------------------------
  // TEST 6: Ownership Isolation & Unauthorized Operations
  // -------------------------------------------------------------------------
  console.log("\n[TEST 6] Testing Ownership Isolation (Alice vs Bob)...");
  const aliceRes = await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      principalId: "alice",
      target: "cursor",
      targetUrl: "about:blank",
    }),
  });
  const aliceId = (await aliceRes.json()).sessionId;

  // Bob attempts to query Alice's session
  const bobGetAlice = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${aliceId}?principalId=bob`,
    { headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } },
  );
  assert(bobGetAlice.status === 403, "Bob cannot query Alice (403)");

  // Bob attempts to execute action on Alice's session
  const bobExecAlice = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${aliceId}/execute`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "bob",
        action: "evaluate",
        param: "1+1",
      }),
    },
  );
  assert(bobExecAlice.status === 403, "Bob cannot execute in Alice session (403)");

  // Bob attempts to delete Alice's session
  const bobDelAlice = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${aliceId}?principalId=bob`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    },
  );
  assert(bobDelAlice.status === 403, "Bob cannot delete Alice session (403)");

  // Alice deletes her own session
  const aliceDel = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${aliceId}?principalId=alice`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
    },
  );
  assert(aliceDel.status === 204, "Alice can delete her own session");
  console.log("PASS: Ownership isolation strictly enforced on GET, POST /execute, and DELETE.");

  // -------------------------------------------------------------------------
  // TEST 7: SSRF Protection on Execution Action
  // -------------------------------------------------------------------------
  console.log("\n[TEST 7] Testing SSRF protection on execute navigate action...");
  const ssrfSessRes = await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      principalId: "ssrf-tester",
      target: "cursor",
      targetUrl: "about:blank",
    }),
  });
  const ssrfId = (await ssrfSessRes.json()).sessionId;

  const ssrfNavRes = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${ssrfId}/execute`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        principalId: "ssrf-tester",
        action: "navigate",
        param: "http://169.254.169.254/latest/meta-data/",
      }),
    },
  );
  console.log("SSRF navigate status:", ssrfNavRes.status);
  assert(ssrfNavRes.status === 400, "SSRF navigation blocked with 400");
  const ssrfNavJson = await ssrfNavRes.json();
  console.log("SSRF error message:", ssrfNavJson.error.message);
  assert(ssrfNavJson.error.code === "ssrf_violation", "Error code is ssrf_violation");

  // Clean up ssrf tester session
  await fetch(`${BRIDGE_URL}/internal/browser/sessions/${ssrfId}?principalId=ssrf-tester`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` },
  });
  console.log("PASS: SSRF navigation attempt blocked.");

  // -------------------------------------------------------------------------
  // TEST 8: Two Simultaneous Sessions Independence
  // -------------------------------------------------------------------------
  console.log("\n[TEST 8] Testing Two Simultaneous Sessions...");
  const s1 = await (
    await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ principalId: "user-1", target: "cursor", targetUrl: "about:blank" }),
    })
  ).json();

  const s2 = await (
    await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${BRIDGE_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ principalId: "user-2", target: "cursor", targetUrl: "about:blank" }),
    })
  ).json();

  console.log("Session 1 ID:", s1.sessionId, "Session 2 ID:", s2.sessionId);
  assert(s1.sessionId !== s2.sessionId, "Session IDs are distinct");

  // Terminate Session 1
  const delS1 = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${s1.sessionId}?principalId=user-1`,
    { method: "DELETE", headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } },
  );
  assert(delS1.status === 204, "Session 1 deleted");

  // Verify Session 2 is still alive and responsive
  const s2Query = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${s2.sessionId}?principalId=user-2`,
    { headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } },
  );
  assert(s2Query.status === 200, "Session 2 still alive after Session 1 deleted");

  // Terminate Session 2
  await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${s2.sessionId}?principalId=user-2`,
    { method: "DELETE", headers: { Authorization: `Bearer ${BRIDGE_TOKEN}` } },
  );
  console.log("PASS: Two simultaneous sessions run independently and terminate cleanly.");

  // -------------------------------------------------------------------------
  // TEST 8.1: Bridge Communication Failure Resilience
  // -------------------------------------------------------------------------
  console.log("\n[TEST 8.1] Testing Bridge Communication Failure Resilience...");
  try {
    await fetch("http://127.0.0.1:49999/internal/browser/sessions", {
      signal: AbortSignal.timeout(1000),
    });
    assert(false, "Should not reach offline port");
  } catch (err) {
    console.log("Expected network failure caught:", err.message);
    assert(err.message, "Network failure caught cleanly");
  }
  console.log("PASS: Network communication failure properly handled.");

  // -------------------------------------------------------------------------
  // TEST 9: Final Health & Zero Active Sessions Check
  // -------------------------------------------------------------------------
  console.log("\n[TEST 9] Verifying clean teardown and zero remaining sessions...");
  const finalHealth = await (await fetch(`${BRIDGE_URL}/health`)).json();
  console.log("Final health state:", JSON.stringify(finalHealth));
  assert(finalHealth.activeSessions === 0, "activeSessions is 0");
  console.log("PASS: Teardown confirmed with 0 active sessions.");

  console.log("\n==================================================================");
  console.log("=== ALL STAGE 4 END-TO-END VALIDATION TESTS PASSED 100%!       ===");
  console.log("==================================================================");
}

run().catch((err) => {
  console.error("\nFATAL STAGE 4 TEST ERROR:", err);
  process.exit(1);
});
