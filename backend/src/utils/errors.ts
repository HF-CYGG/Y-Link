export class BizError extends Error {
  statusCode: number

  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'BizError'
    this.statusCode = statusCode
  }
}
