import { describe, expect, it } from "vitest";
import { briefMessage, MESSAGE_LIMIT } from "../src/catalog";

describe("briefMessage", () => {
  it("keeps a short message as it is", () => {
    expect(briefMessage("403 Access denied")).toBe("403 Access denied");
  });

  it("collapses the line breaks and indentation of an error page", () => {
    expect(briefMessage("403\n  <html>\n\t<body>Forbidden</body>\n</html>\n")).toBe("403 <html> <body>Forbidden</body> </html>");
  });

  it("caps a long response body and marks the cut", () => {
    const out = briefMessage(`403 ${"x".repeat(5000)}`);
    expect(out).toHaveLength(MESSAGE_LIMIT);
    expect(out.startsWith("403 xxx")).toBe(true);
    expect(out.endsWith("…")).toBe(true);
  });
});
