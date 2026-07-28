export interface TokenEstimator {
  readonly count: (value: string) => number;
}

export const defaultTokenEstimator: TokenEstimator = {
  count(value) {
    if (value === "") return 0;
    let asciiUnits = 0;
    let nonAsciiUnits = 0;
    for (const character of value) {
      if (character.codePointAt(0)! <= 0x7f) asciiUnits += 1;
      else nonAsciiUnits += 1;
    }
    return nonAsciiUnits + Math.ceil(asciiUnits / 4);
  },
};
