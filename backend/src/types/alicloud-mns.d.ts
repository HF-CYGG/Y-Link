declare module '@alicloud/mns' {
  interface MnsStsCredentials {
    accessKeyId: string
    accessKeySecret: string
    securityToken: string
  }

  interface MnsClientOptions {
    accessKeyId: string
    accessKeySecret: string
    endpoint: string
    securityToken: string
    refreshSTSToken?: () => Promise<MnsStsCredentials>
    refreshSTSTokenInterval?: number
  }

  interface MnsMessageClient {
    batchReceiveMessage(queueName: string, numOfMessages: number, waitSeconds: number): Promise<unknown>
    deleteMessage(queueName: string, receiptHandle: string): Promise<unknown>
  }

  class MNSClient implements MnsMessageClient {
    constructor(accountId: string, options: MnsClientOptions)
    batchReceiveMessage(queueName: string, numOfMessages: number, waitSeconds: number): Promise<unknown>
    deleteMessage(queueName: string, receiptHandle: string): Promise<unknown>
  }

  export = MNSClient
}
