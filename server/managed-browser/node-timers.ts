
// The plugin client brings React Native's numeric global timer overloads into
// the project. These wrappers execute only in Node and retain real unref handles.
export function setTimeout(callback: (...args: any[]) => void, ms?: number): NodeJS.Timeout {
  return globalThis.setTimeout(callback, ms) as unknown as NodeJS.Timeout;
}
export function setInterval(callback: (...args: any[]) => void, ms?: number): NodeJS.Timeout {
  return globalThis.setInterval(callback, ms) as unknown as NodeJS.Timeout;
}
export function clearTimeout(timer: NodeJS.Timeout | undefined | null): void { globalThis.clearTimeout(timer ?? undefined); }
export function clearInterval(timer: NodeJS.Timeout | undefined | null): void { globalThis.clearInterval(timer ?? undefined); }
