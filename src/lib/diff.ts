export type DiffSegment =
  | { kind: "equal"; lines: string[] }
  | { kind: "mod"; left: string[]; right: string[] };

function toLines(raw: string): string[] {
  if (!raw) return [];
  return raw.replace(/\r\n/g, "\n").split("\n");
}

export function diffLines(leftRaw: string, rightRaw: string): DiffSegment[] {
  const A = toLines(leftRaw);
  const B = toLines(rightRaw);
  const n = A.length;
  const m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        A[i] === B[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const segs: DiffSegment[] = [];
  let eqBuf: string[] = [];
  let modLeft: string[] = [];
  let modRight: string[] = [];
  const flushEq = () => {
    if (eqBuf.length) {
      segs.push({ kind: "equal", lines: eqBuf });
      eqBuf = [];
    }
  };
  const flushMod = () => {
    if (modLeft.length || modRight.length) {
      segs.push({ kind: "mod", left: modLeft, right: modRight });
      modLeft = [];
      modRight = [];
    }
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      flushMod();
      eqBuf.push(A[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      flushEq();
      modLeft.push(A[i]);
      i++;
    } else {
      flushEq();
      modRight.push(B[j]);
      j++;
    }
  }
  while (i < n) {
    flushEq();
    modLeft.push(A[i]);
    i++;
  }
  while (j < m) {
    flushEq();
    modRight.push(B[j]);
    j++;
  }
  flushEq();
  flushMod();
  return segs;
}

export function buildRight(
  segs: DiffSegment[],
  applied: Set<number>,
): string {
  const out: string[] = [];
  segs.forEach((seg, idx) => {
    if (seg.kind === "equal") out.push(...seg.lines);
    else if (applied.has(idx)) out.push(...seg.left);
    else out.push(...seg.right);
  });
  return out.join("\n");
}
