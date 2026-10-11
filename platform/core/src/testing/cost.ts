/**
 * For tests only, and not exported from the package: how many times as much each unit of work
 * costs in `large` as in `small`, which does `times` fewer units. Work that grows in step with its
 * size costs about the same per unit in both, so the answer is about 1. Work that grows with the
 * square of its size costs about `times` as much per unit.
 *
 * It counts this process's CPU time, not time on the clock. A busy machine, like CI running every
 * package's tests at once, stretches the clock for whatever it runs, by more than any fixed bound
 * on it could allow. Each round runs `small` `times` over and `large` once, so both take about as
 * long as each other, and the cheapest of the rounds for each is what counts.
 */
export function costRatio(
  small: () => unknown,
  large: () => unknown,
  times: number,
  rounds = 3,
): number {
  small(); // V8 compiles the work before any round counts.
  let cheapestSmall = Infinity;
  let cheapestLarge = Infinity;
  for (let round = 0; round < rounds; round += 1) {
    let started = cpuMicroseconds();
    for (let run = 0; run < times; run += 1) small();
    cheapestSmall = Math.min(cheapestSmall, cpuMicroseconds() - started);
    started = cpuMicroseconds();
    large();
    cheapestLarge = Math.min(cheapestLarge, cpuMicroseconds() - started);
  }
  return cheapestLarge / cheapestSmall;
}

function cpuMicroseconds(): number {
  const { user, system } = process.cpuUsage();
  return user + system;
}
