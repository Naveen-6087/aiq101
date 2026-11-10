// A `catch` block in TypeScript receives `unknown`, not `Error`. The thrown
// value could be anything. This is the one place that decides how to read it.
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
