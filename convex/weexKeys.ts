// 纯工具（无 Node API），供普通 runtime 函数使用
export function makeRequestKey(signalNo: string, action: string, price: number): string {
  return `${signalNo}:${action}:${price}`;
}
