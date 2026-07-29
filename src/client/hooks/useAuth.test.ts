import { describe, expect, test } from "bun:test";
import { applyAuthStatusFailure, applyAuthStatusSuccess, shouldPollAuthStatus } from "./useAuth";

describe("auth status refresh state", () => {
  test("retains a confirmed user, retries, and consumes the later success", () => {
    const failed = applyAuthStatusFailure({
      auth: {
        authenticated: true,
        user: { id: "user-1", email: "user-1@example.com" },
        loading: false,
        isInitializing: false,
        passwordResetPending: false,
        setupComplete: true,
      },
      retryPending: false,
    });

    expect(failed.auth.authenticated).toBeTrue();
    expect(failed.auth.user?.id).toBe("user-1");
    expect(failed.auth.setupComplete).toBeTrue();
    expect(failed.auth.loading).toBeFalse();
    expect(shouldPollAuthStatus(failed.auth, failed.retryPending)).toBeTrue();

    const recovered = applyAuthStatusSuccess(failed, {
      authenticated: true,
      user: { id: "user-1", email: "updated@example.com" },
      setupComplete: true,
    });
    expect(recovered.retryPending).toBeFalse();
    expect(recovered.auth.user?.email).toBe("updated@example.com");
    expect(shouldPollAuthStatus(recovered.auth, recovered.retryPending)).toBeFalse();
  });

  test("keeps initial loading active so status polling continues", () => {
    const state = applyAuthStatusFailure({
      auth: {
        authenticated: false,
        user: null,
        loading: true,
        isInitializing: false,
        passwordResetPending: false,
        setupComplete: false,
      },
      retryPending: false,
    });

    expect(state.auth.loading).toBeTrue();
    expect(state.auth.authenticated).toBeFalse();
    expect(shouldPollAuthStatus(state.auth, state.retryPending)).toBeTrue();
  });
});
