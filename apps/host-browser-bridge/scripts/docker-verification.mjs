const BRIDGE_URL = process.env.BRIDGE_URL || "http://host.docker.internal:4318";
const TOKEN = process.env.BRIDGE_TOKEN || "stage3-secure-token-xyz";

async function run() {
  console.log("=== STARTING DOCKER CONTAINER -> WINDOWS BRIDGE TEST ===");
  console.log("Bridge URL:", BRIDGE_URL);

  // 1. Health check
  console.log("\n[Test 1] Healthcheck from Docker...");
  const healthRes = await fetch(`${BRIDGE_URL}/health`);
  const healthJson = await healthRes.json();
  console.log("Healthcheck status:", healthRes.status, healthJson);
  if (healthRes.status !== 200 || healthJson.status !== "ok") {
    throw new Error("Healthcheck failed");
  }
  console.log("PASS: Docker container can reach Windows Bridge.");

  // 2. Unauthorized without token
  console.log("\n[Test 2] Request without token (should be 401)...");
  const unauthRes = await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ principalId: "u1", target: "cursor" }),
  });
  console.log("Unauth status:", unauthRes.status);
  if (unauthRes.status !== 401) throw new Error("Expected 401 Unauthorized");
  console.log("PASS: Unauthenticated request rejected.");

  // 3. Unauthorized with invalid token
  console.log("\n[Test 3] Request with invalid token (should be 401)...");
  const badTokenRes = await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer invalid-token-abc",
    },
    body: JSON.stringify({ principalId: "u1", target: "cursor" }),
  });
  console.log("Bad token status:", badTokenRes.status);
  if (badTokenRes.status !== 401) throw new Error("Expected 401 Unauthorized");
  console.log("PASS: Bad token rejected.");

  // 4. SSRF block test
  console.log("\n[Test 4] Request with SSRF metadata targetUrl (should be 400)...");
  const ssrfRes = await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      principalId: "u1",
      target: "cursor",
      targetUrl: "http://169.254.169.254/latest/meta-data/",
    }),
  });
  const ssrfJson = await ssrfRes.json();
  console.log("SSRF block status:", ssrfRes.status, ssrfJson);
  if (ssrfRes.status !== 400 || ssrfJson?.error?.code !== "ssrf_violation") {
    throw new Error("Expected 400 ssrf_violation");
  }
  console.log("PASS: SSRF metadata access blocked.");

  // 5. Create Session 1 (Alice)
  console.log("\n[Test 5] Creating Session 1 for Alice from Docker...");
  const sess1Res = await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      principalId: "user-alice",
      target: "cursor",
      targetUrl: "about:blank",
    }),
  });
  const sess1Json = await sess1Res.json();
  console.log("Session 1 Response:", sess1Res.status, sess1Json);
  if (sess1Res.status !== 201) throw new Error("Expected 201 Created for Session 1");
  const session1Id = sess1Json.sessionId;
  console.log("PASS: Session 1 created from Docker container:", session1Id);

  // 6. Create Session 2 (Bob)
  console.log("\n[Test 6] Creating Session 2 for Bob from Docker...");
  const sess2Res = await fetch(`${BRIDGE_URL}/internal/browser/sessions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      principalId: "user-bob",
      target: "cursor",
      targetUrl: "about:blank",
    }),
  });
  const sess2Json = await sess2Res.json();
  console.log("Session 2 Response:", sess2Res.status, sess2Json);
  if (sess2Res.status !== 201) throw new Error("Expected 201 Created for Session 2");
  const session2Id = sess2Json.sessionId;
  console.log("PASS: Session 2 created from Docker container:", session2Id);

  // 7. Ownership isolation: Bob tries to query Alice's session
  console.log("\n[Test 7] Bob tries to query Alice's session (should be 403)...");
  const bobQueryAlice = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${session1Id}?principalId=user-bob`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  );
  console.log("Bob query Alice status:", bobQueryAlice.status);
  if (bobQueryAlice.status !== 403) throw new Error("Expected 403 Forbidden");
  console.log("PASS: Ownership isolation verified (Bob cannot query Alice).");

  // 8. Alice queries her session
  console.log("\n[Test 8] Alice queries her own session...");
  const aliceQuery = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${session1Id}?principalId=user-alice`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  );
  const aliceJson = await aliceQuery.json();
  console.log("Alice query status:", aliceQuery.status, aliceJson);
  if (aliceQuery.status !== 200 || aliceJson.status !== "waiting_for_login") {
    throw new Error("Expected 200 with waiting_for_login");
  }
  console.log("PASS: Alice session query successful.");

  // 9. Alice deletes her session
  console.log("\n[Test 9] Alice deletes her session...");
  const aliceDel = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${session1Id}?principalId=user-alice`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  );
  console.log("Alice delete status:", aliceDel.status);
  if (aliceDel.status !== 204) throw new Error("Expected 204 No Content");
  console.log("PASS: Alice session deleted.");

  // 10. Verify Bob's session is STILL active
  console.log("\n[Test 10] Verifying Bob's session remained alive after Alice deleted hers...");
  const bobQuery = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${session2Id}?principalId=user-bob`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  );
  const bobJson = await bobQuery.json();
  console.log("Bob query status:", bobQuery.status, bobJson);
  if (bobQuery.status !== 200 || bobJson.status !== "waiting_for_login") {
    throw new Error("Expected 200 with waiting_for_login for Bob");
  }
  console.log("PASS: Bob session isolated and completely unaffected.");

  // 11. Bob deletes his session
  console.log("\n[Test 11] Bob deletes his session...");
  const bobDel = await fetch(
    `${BRIDGE_URL}/internal/browser/sessions/${session2Id}?principalId=user-bob`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TOKEN}` },
    },
  );
  console.log("Bob delete status:", bobDel.status);
  if (bobDel.status !== 204) throw new Error("Expected 204 No Content");
  console.log("PASS: Bob session deleted.");

  // 12. Final healthcheck confirms 0 active sessions
  console.log("\n[Test 12] Final healthcheck...");
  const finalHealth = await fetch(`${BRIDGE_URL}/health`);
  const finalJson = await finalHealth.json();
  console.log("Final active sessions:", finalJson.activeSessions);
  if (finalJson.activeSessions !== 0) throw new Error("Expected 0 active sessions");
  console.log("PASS: 0 active sessions remaining. Cleanup 100% verified.");

  console.log("\n=== ALL DOCKER -> WINDOWS BRIDGE TESTS PASSED SUCCESSFULLY! ===");
}

run().catch((err) => {
  console.error("FATAL DOCKER TEST ERROR:", err);
  process.exit(1);
});

