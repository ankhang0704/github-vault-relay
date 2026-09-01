import { describe, it, expect } from "vitest";
import { redactTokens, sanitizeErrorMessage } from "../src/security/redact";
import { GitHubError } from "../src/github/githubClient";

describe("Token Redaction & Security", () => {
  const secretPat = "github_pat_11AABBCCDDEEFFGGHHIIJJKK_1234567890abcdefghijklmnopqrstuvwxyz";
  const classicToken = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  const customSecret = "super_secret_token_12345";

  describe("redactTokens", () => {
    it("redacts fine-grained PAT tokens", () => {
      const input = `Error connecting with token ${secretPat} to endpoint`;
      const result = redactTokens(input);
      expect(result).not.toContain(secretPat);
      expect(result).toContain("[REDACTED_TOKEN]");
    });

    it("redacts classic personal access tokens (ghp_...)", () => {
      const input = `Authentication failed for user token ${classicToken}`;
      const result = redactTokens(input);
      expect(result).not.toContain(classicToken);
      expect(result).toContain("[REDACTED_TOKEN]");
    });

    it("redacts Authorization headers and Bearer tokens", () => {
      const inputAuth = `Request headers: Authorization: Bearer some_secret_jwt_or_pat_here`;
      const resultAuth = redactTokens(inputAuth);
      expect(resultAuth).not.toContain("some_secret_jwt_or_pat_here");
      expect(resultAuth).toContain("Authorization: [REDACTED_TOKEN]");

      const inputBearer = `Token was passed as Bearer some_secret_jwt_or_pat_here in payload`;
      const resultBearer = redactTokens(inputBearer);
      expect(resultBearer).not.toContain("some_secret_jwt_or_pat_here");
      expect(resultBearer).toContain("Bearer [REDACTED_TOKEN]");
    });

    it("redacts query parameter tokens in URLs", () => {
      const input = "https://api.github.com/repos/user/repo?access_token=secret_12345&other=1";
      const result = redactTokens(input);
      expect(result).not.toContain("secret_12345");
      expect(result).toBe("https://api.github.com/repos/user/repo?access_token=[REDACTED_TOKEN]&other=1");
    });

    it("redacts explicit specific configured token", () => {
      const input = `Failed to authorize with custom token: ${customSecret}`;
      const result = redactTokens(input, customSecret);
      expect(result).not.toContain(customSecret);
      expect(result).toContain("[REDACTED_TOKEN]");
    });
  });

  describe("sanitizeErrorMessage", () => {
    it("sanitizes Error instances containing tokens", () => {
      const err = new Error(`HTTP 401 Unauthorized for token ${secretPat}`);
      const sanitized = sanitizeErrorMessage(err, secretPat);
      expect(sanitized).not.toContain(secretPat);
      expect(sanitized).toContain("[REDACTED_TOKEN]");
    });

    it("sanitizes object errors", () => {
      const errObj = {
        message: "Failed",
        token: secretPat,
        url: `https://api.github.com?token=${secretPat}`,
      };
      const sanitized = sanitizeErrorMessage(errObj, secretPat);
      expect(sanitized).not.toContain(secretPat);
    });

    it("GitHubError class automatically redacts tokens", () => {
      const gitHubErr = new GitHubError(
        `Failed request with auth: ${secretPat}`,
        401,
        "Unauthorized",
        secretPat
      );
      expect(gitHubErr.message).not.toContain(secretPat);
      expect(gitHubErr.message).toContain("[REDACTED_TOKEN]");
    });
  });
});
