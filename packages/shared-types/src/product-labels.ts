/** 标签打印库位只影响本次纸面；main_only 不包含数量、其他库位或分布指纹。 */
export type PrintMainLocationStatus = 'valid' | 'unset' | 'missing' | 'disabled'
export interface PrintLocationOption { locationId: string; locationCode: string; isMain: boolean }
interface PrintLocationsBase { mainLocationId: string | null; mainLocationCode: string | null; mainLocationStatus: PrintMainLocationStatus }
export type ProductPrintLocations =
  | (PrintLocationsBase & { capability: 'main_only'; options: PrintLocationOption[] })
  | (PrintLocationsBase & { capability: 'full'; options: Array<PrintLocationOption & { qty: number }>; distributionKey: string })
