/**
 * XLSX 导出共用件：表头加粗 + 列宽 + 浏览器下载
 *
 * 库选 write-excel-file 而非 exceljs：三处导出实际只用到「表头加粗 + 列宽 + 写盘」，
 * 而 exceljs 约 900KB 且经 uuid 传递依赖带入一条与本仓不可达的告警；本库约 30KB，
 * 传递依赖只有 fflate。下载由库按文件名触发，调用点不再各拼一份 Blob + anchor。
 */
import writeXlsxFile from 'write-excel-file/browser'

/** 列声明：header 进表头行（加粗），width 为该列宽度（Excel 字符宽） */
export type XlsxColumn = { header: string; width: number }

/** 单元格值：导出只产出文本与数字（布尔/时间在调用点先格式化成中文与本地时间） */
export type XlsxValue = string | number

/**
 * 生成并下载 XLSX：首行表头（加粗），列宽由第二参数的 columns 逐列声明，其余行按列顺序取值。
 */
export async function downloadXlsx(
  sheetName: string,
  columns: readonly XlsxColumn[],
  rows: readonly XlsxValue[][],
  fileName: string,
): Promise<void> {
  const data = [
    columns.map((column) => ({ value: column.header, fontWeight: 'bold' as const })),
    ...rows.map((row) => row.map((value) => ({ value }))),
  ]
  await writeXlsxFile(
    data,
    { sheet: sheetName, columns: columns.map((column) => ({ width: column.width })) },
    {},
  ).toFile(fileName)
}
