/**
 * The proof seams that tamper with a socket's answers, isolated instances
 * only (TEMP_CODE_USER_DATA): `method:count[,method:count]`, the first
 * `count` requests of each `method` taken (count 1 when absent).
 * TEMP_CODE_DROP_ANSWERS never sends those answers (a lost response);
 * TEMP_CODE_FAIL_ANSWERS answers them with an error (a host that erred while
 * the link stayed open, as the phone's catalog retry meets it). A proof's
 * own server adds to them in process (the iOS test server's `POST /fail`).
 */
export class AnswerSeam {
  private readonly left = new Map<string, number>()

  constructor(spec?: string) {
    for (const part of spec?.split(',') ?? []) {
      const [method, count] = part.split(':')
      if (method?.trim()) this.add(method.trim(), Number(count) || 1)
    }
  }

  /** Takes the next `count` requests of `method` as well. */
  add(method: string, count = 1): void {
    this.left.set(method, (this.left.get(method) ?? 0) + Math.max(0, count))
  }

  /** Whether this request of `method` is one the seam takes. */
  take(method: string): boolean {
    const n = this.left.get(method) ?? 0
    if (n <= 0) return false
    this.left.set(method, n - 1)
    return true
  }
}

const isolated = Boolean(process.env.TEMP_CODE_USER_DATA)
export const dropAnswers = new AnswerSeam(isolated ? process.env.TEMP_CODE_DROP_ANSWERS : undefined)
export const failAnswers = new AnswerSeam(isolated ? process.env.TEMP_CODE_FAIL_ANSWERS : undefined)

/** The error a failed request is answered with. */
export const FAILED_ANSWER = 'internal: failed by the answer seam (TEMP_CODE_FAIL_ANSWERS)'
