import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

export interface ConsoleChatRunOptions {
  readonly initialMessage?: string | undefined;
  readonly onMessage: (message: string) => Promise<void> | void;
}

export interface ConsoleChat {
  readonly question: (prompt: string) => Promise<string>;
  readonly run: (options: ConsoleChatRunOptions) => Promise<void>;
  readonly close: () => void;
}

export interface CreateConsoleChatOptions {
  readonly prompt?: string | undefined;
  readonly exitCommands?: readonly string[] | undefined;
  readonly input?: NodeJS.ReadableStream | undefined;
  readonly output?: NodeJS.WritableStream | undefined;
}

export function createConsoleChat(options: CreateConsoleChatOptions = {}): ConsoleChat {
  const readline = createInterface({
    input: options.input ?? stdin,
    output: options.output ?? stdout,
  });
  const prompt = options.prompt ?? "You> ";
  const exitCommands = new Set(options.exitCommands ?? ["/exit", "/quit"]);

  return {
    question: async (questionPrompt) => await readline.question(questionPrompt),
    async run(runOptions) {
      let nextMessage = runOptions.initialMessage;

      while (true) {
        const message = nextMessage ?? (await readline.question(prompt));
        nextMessage = undefined;
        const trimmedMessage = message.trim();

        if (exitCommands.has(trimmedMessage)) {
          return;
        }
        if (trimmedMessage.length === 0) {
          continue;
        }

        await runOptions.onMessage(trimmedMessage);
      }
    },
    close() {
      readline.close();
    },
  };
}
