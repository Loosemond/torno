/**
 * Kill an agent that ignored the hangup, and with it whatever it started: a
 * PTY's child leads a process group of its own. The process alone, if the
 * group is no longer there. Nothing for a pid that is not above 1.
 */
export function killGroup(pid: number, kill: (target: number, signal: string) => void = process.kill): void {
  signalGroup(pid, 'SIGKILL', kill)
}

/** A signal to the group an agent leads, and to the process alone if the group is no longer there. */
export function signalGroup(pid: number, name: string, kill: (target: number, signal: string) => void = process.kill): void {
  // Never 0 or 1 negated: -0 is this process's own group, and -1 every process it may signal.
  if (!Number.isInteger(pid) || pid <= 1) return
  for (const target of [-pid, pid]) {
    try {
      kill(target, name)
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return
    }
  }
}
