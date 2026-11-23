import { describe, expect, it } from "vitest";
import { connectionFailure } from "../src/adapters/errors";
import { explainTestResult, httpLabel, parseTestMessage } from "../src/gateway/explain";

const ctx = { authHeader: "Ocp-Apim-Subscription-Key", extraHeaders: [] as string[], url: "https://gateway.example/anthropic/v1/messages" };
const explain = (status: string, statusCode: number | undefined, statusMessage: string, c = ctx) => explainTestResult({ status, statusCode, statusMessage }, c)!;

describe("explaining model tests", () => {
  it("reads the SDK's '<code> {json}' messages and the latency suffix", () => {
    expect(parseTestMessage('400 {"error":{"message":"Missing required header x-charge-code","type":"invalid_request_error"}} (812 ms)')).toEqual({ said: "Missing required header x-charge-code", latencyMs: 812 });
    expect(parseTestMessage('401 {"statusCode":401,"message":"Access denied due to invalid subscription key."} (90 ms)')).toEqual({ said: "Access denied due to invalid subscription key.", latencyMs: 90 });
    expect(parseTestMessage("1065 ms")).toEqual({ latencyMs: 1065 });
    expect(httpLabel(400)).toBe("HTTP 400 Bad Request");
    expect(httpLabel(undefined)).toBe("No answer");
  });

  it("says a success is a success, with nothing to fix", () => {
    const ex = explain("entitled", 200, "1065 ms");
    expect(ex).toMatchObject({ tone: "ok", code: "HTTP 200 OK", latencyMs: 1065 });
    expect(ex.action).toBeUndefined();
  });

  it("names a missing header, and says where to add it", () => {
    const ex = explain("entitled", 400, '400 {"error":{"message":"Missing required header x-charge-code"}} (40 ms)');
    expect(ex.tone).toBe("warn");
    expect(ex.meaning).toBe("The gateway requires the x-charge-code header, which Rig did not send.");
    expect(ex.action).toMatch(/Add x-charge-code under Connection/);
    // Already sent: then its value is the problem.
    const sent = explain("entitled", 400, "400 The x-charge-code header is required (40 ms)", { ...ctx, extraHeaders: ["x-charge-code"] });
    expect(sent.meaning).toMatch(/although Rig sends it/);
  });

  it("separates a key in the wrong header from a wrong key", () => {
    expect(explain("unauthorized", 401, "401 Access denied due to missing subscription key. Make sure to include subscription key when making requests to an API. (20 ms)").meaning).toMatch(
      /did not find a key where it looks for one\. Rig sends the key in Ocp-Apim-Subscription-Key/,
    );
    expect(explain("unauthorized", 401, "401 Access denied due to invalid subscription key. (20 ms)").meaning).toMatch(/rejected the key sent in Ocp-Apim-Subscription-Key/);
  });

  it("explains the common gateway and model answers", () => {
    expect(explain("not_found", 404, '404 {"statusCode":404,"message":"Resource not found"} (10 ms)').meaning).toContain("https://gateway.example/anthropic/v1/messages");
    expect(explain("not_found", 404, "404 model: claude-nope (10 ms)").meaning).toMatch(/does not have a model or deployment with this name/);
    expect(explain("forbidden", 403, "403 The subscription is not entitled to this deployment (10 ms)").meaning).toMatch(/not allowed to use this model/);
    expect(explain("entitled", 400, "400 temperature: sampling parameters are not supported (10 ms)").action).toMatch(/Clear Temperature/);
    expect(explain("entitled", 400, "400 Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead. (10 ms)").action).toMatch(/max tokens field/);
    expect(explain("entitled", 400, "400 The API deployment for this resource does not exist. (10 ms)").meaning).toMatch(/does not recognise the model or deployment/);
    expect(explain("rate_limited", 429, "429 You exceeded your current quota (10 ms)").meaning).toMatch(/quota/);
    expect(explain("unknown", 502, "502 Bad Gateway (10 ms)").meaning).toMatch(/could not reach the model service/);
    expect(explain("unknown", 529, '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}} (10 ms)').meaning).toMatch(/overloaded/);
  });

  it("explains failures to connect by their cause", () => {
    expect(explain("unknown", undefined, "Connection error: ENOTFOUND, getaddrinfo ENOTFOUND gateway.example (30 ms)")).toMatchObject({ code: "No answer", tone: "bad" });
    expect(explain("unknown", undefined, "Connection error: ENOTFOUND (30 ms)").meaning).toMatch(/host name could not be found/);
    expect(explain("unknown", undefined, "Connection error: ECONNREFUSED (3 ms)").meaning).toMatch(/nothing accepted the connection/);
    expect(explain("unknown", undefined, "Connection error: UNABLE_TO_GET_ISSUER_CERT_LOCALLY, unable to get local issuer certificate (40 ms)").action).toMatch(/certificate trust/);
    expect(explain("unknown", undefined, "Request timed out. (30000 ms)").meaning).toMatch(/Nothing answered in time/);
  });

  it("brings the cause of a connection failure up from the SDK's cause chain", () => {
    const fetchError = Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("getaddrinfo ENOTFOUND gateway.example"), { code: "ENOTFOUND" }) });
    const sdkError = Object.assign(new Error("Connection error."), { cause: fetchError });
    expect(connectionFailure(sdkError).message).toBe("Connection error: fetch failed, ENOTFOUND, getaddrinfo ENOTFOUND gateway.example");
  });

  it("leaves untested models unexplained", () => {
    expect(explainTestResult({ status: "unprobed" })).toBeUndefined();
  });
});

describe("results saved before HTTP codes were recorded", () => {
  it("infers the code from the status instead of saying nothing answered", () => {
    expect(explainTestResult({ status: "entitled", statusMessage: "900 ms" })).toMatchObject({ code: "Answered", tone: "ok" });
    expect(explainTestResult({ status: "unauthorized", statusMessage: "401 invalid key (20 ms)" })?.code).toBe("HTTP 401 Unauthorized");
    expect(explainTestResult({ status: "not_found" })?.code).toBe("HTTP 404 Not Found");
  });
});

describe("APIM's ambiguous 401", () => {
  it("covers both a key in the wrong header and a wrong key", () => {
    const ex = explainTestResult({ status: "unauthorized", statusCode: 401, statusMessage: "401 Access denied due to missing or invalid subscription key. (20 ms)" }, { authHeader: "Authorization" })!;
    expect(ex.meaning).toBe("The gateway did not accept a key: either it is not where the gateway looks, or it is wrong. Rig sends the key in Authorization.");
    expect(ex.action).toMatch(/Ocp-Apim-Subscription-Key/);
  });
});
