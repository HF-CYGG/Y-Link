/**
 * 模块说明：客户端商城 SKU 分组选择辅助模块。
 * 文件职责：为商品详情提供可独立验证的规格分组与组合选择模型。
 */

import type { O2oMallSku } from '@/api/modules/o2o'

export interface ClientSkuOptionView {
  value: string
  selected: boolean
  disabled: boolean
}

export interface ClientSkuSpecGroupView {
  name: string
  options: ClientSkuOptionView[]
}

type ClientSkuSpecSource = Pick<O2oMallSku, 'specValues' | 'specText' | 'skuCode'>

const readSkuSpecEntries = (sku: ClientSkuSpecSource | null) => {
  if (!sku) {
    return []
  }
  const configuredEntries = Object.entries(sku.specValues ?? {})
    .map(([name, value]) => [name.trim(), String(value ?? '').trim()] as const)
    .filter(([name, value]) => name && value)
  if (configuredEntries.length) {
    return configuredEntries
  }
  const fallbackValue = sku.specText?.trim() || sku.skuCode?.trim() || ''
  return fallbackValue ? [['规格', fallbackValue] as const] : []
}

const readSkuSpecValueMap = (sku: ClientSkuSpecSource | null) => Object.fromEntries(readSkuSpecEntries(sku))

const readSpecGroupNames = (skus: O2oMallSku[]) => {
  const groupNames: string[] = []
  skus.forEach((sku) => {
    readSkuSpecEntries(sku).forEach(([name]) => {
      if (!groupNames.includes(name)) {
        groupNames.push(name)
      }
    })
  })
  return groupNames
}

const hasAvailableStock = (sku: Pick<O2oMallSku, 'availableStock'>) => Math.max(0, Number(sku.availableStock ?? 0)) > 0

const resolvePreferredAvailableSku = (skus: O2oMallSku[]) => {
  return skus.find((sku) => sku.o2oRecommended === true && hasAvailableStock(sku))
    ?? skus.find(hasAvailableStock)
}

export const buildClientSkuSelectionModel = (
  skus: O2oMallSku[],
  selectedSku: O2oMallSku | null,
): ClientSkuSpecGroupView[] => {
  const groupNames = readSpecGroupNames(skus)
  const selectedSpecValues = readSkuSpecValueMap(selectedSku)

  return groupNames.map((name, groupIndex) => {
    const previousGroupNames = groupNames.slice(0, groupIndex)
    const candidateSkus = skus.filter((sku) => previousGroupNames.every(
      (previousName) => readSkuSpecValueMap(sku)[previousName] === selectedSpecValues[previousName],
    ))
    const optionValues: string[] = []
    candidateSkus.forEach((sku) => {
      const value = readSkuSpecValueMap(sku)[name] ?? ''
      if (value && !optionValues.includes(value)) {
        optionValues.push(value)
      }
    })

    return {
      name,
      options: optionValues.map((value) => {
        const matchingSkus = candidateSkus.filter((sku) => readSkuSpecValueMap(sku)[name] === value)
        return {
          value,
          selected: selectedSpecValues[name] === value,
          disabled: matchingSkus.every((sku) => !hasAvailableStock(sku)),
        }
      }),
    }
  })
}

export const resolveClientSkuSelection = (
  skus: O2oMallSku[],
  selectedSku: O2oMallSku | null,
  groupName: string,
  optionValue: string,
): O2oMallSku | null => {
  const groupNames = readSpecGroupNames(skus)
  const changedGroupIndex = groupNames.indexOf(groupName)
  if (changedGroupIndex < 0) {
    return selectedSku
  }

  const selectedSpecValues = readSkuSpecValueMap(selectedSku)
  selectedSpecValues[groupName] = optionValue
  const exactCandidates = skus.filter((sku) => groupNames.every(
    (name) => readSkuSpecValueMap(sku)[name] === selectedSpecValues[name],
  ))
  const prefixGroupNames = groupNames.slice(0, changedGroupIndex + 1)
  const prefixCandidates = skus.filter((sku) => prefixGroupNames.every(
    (name) => readSkuSpecValueMap(sku)[name] === selectedSpecValues[name],
  ))

  return exactCandidates.find(hasAvailableStock)
    ?? resolvePreferredAvailableSku(prefixCandidates)
    ?? exactCandidates[0]
    ?? prefixCandidates[0]
    ?? selectedSku
}
