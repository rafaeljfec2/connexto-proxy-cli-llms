/**
 * Tracks in-flight response and provider session IDs so lifecycle cleanup
 * never evicts resources tied to active executions.
 */
export class ActiveResourceTracker {
  private readonly activeResponses = new Set<string>();
  private readonly activeSessions = new Set<string>();

  pinResponse(responseId: string): void {
    this.activeResponses.add(responseId);
  }

  unpinResponse(responseId: string): void {
    this.activeResponses.delete(responseId);
  }

  isResponseActive(responseId: string): boolean {
    return this.activeResponses.has(responseId);
  }

  pinSession(sessionId: string): void {
    this.activeSessions.add(sessionId);
  }

  unpinSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  counts(): { activeResponses: number; activeSessions: number } {
    return {
      activeResponses: this.activeResponses.size,
      activeSessions: this.activeSessions.size,
    };
  }

  clear(): void {
    this.activeResponses.clear();
    this.activeSessions.clear();
  }
}
