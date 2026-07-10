import { PassThrough, Readable, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createConsoleChat } from "../src/harness/console-chat.ts";

describe("createConsoleChat", () => {
  it("dispatches trimmed messages until an exit command", async () => {
    const messages: string[] = [];
    const input = new PassThrough();
    const chat = createConsoleChat({
      input,
      output: discardOutput(),
    });

    try {
      const completed = chat.run({
        onMessage: (message) => {
          messages.push(message);
          setTimeout(() => input.write("/exit\n"), 0);
        },
      });
      input.write("  hello  \n");
      await completed;
    } finally {
      chat.close();
    }

    expect(messages).toEqual(["hello"]);
  });

  it("dispatches an initial message before reading the prompt", async () => {
    const messages: string[] = [];
    const chat = createConsoleChat({
      input: Readable.from(["/quit\n"]),
      output: discardOutput(),
    });

    try {
      await chat.run({
        initialMessage: "resume approval",
        onMessage: (message) => {
          messages.push(message);
        },
      });
    } finally {
      chat.close();
    }

    expect(messages).toEqual(["resume approval"]);
  });
});

function discardOutput(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}
