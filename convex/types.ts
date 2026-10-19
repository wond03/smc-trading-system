// 共享类型（避免循环依赖）
export interface PositionLike {
  symbol: string;
  status: string; // open | closed
}
