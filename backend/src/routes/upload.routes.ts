import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BizError } from '../utils/errors.js'

export const uploadRouter = Router()

/**
 * 上传路由说明：
 * - 当前仅开放图片上传，用于商品图片等前端静态展示资源；
 * - 文件落盘到 backend/uploads，由应用静态资源服务对外暴露；
 * - 路由返回的是“可直接访问的 URL”，而不是物理绝对路径。
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // 文件统一上传至 backend/uploads
    cb(null, path.resolve(process.cwd(), 'uploads'))
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase()
    // 生成随机 UUID 作为文件名，防止中文乱码或重名覆盖
    cb(null, `${randomUUID()}${ext}`)
  },
})

// 上传安全边界：
// - 体积限制为 10MB，避免超大文件占满磁盘或拉高请求处理成本；
// - fileFilter 仅允许 image/*，阻断常见的脚本/可执行文件滥传风险。
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 限制最大 10MB
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new BizError('只允许上传图片文件', 400))
    }
  },
})

uploadRouter.post('/', upload.single('file'), (req, res) => {
  if (!req.file) {
    throw new BizError('文件上传失败', 400)
  }

  // 后端对外暴露统一的 uploads 前缀，前端只需保存该相对 URL，
  // 后续域名、静态资源代理方式变化时可以保持业务层无感。
  // 拼接得到可供前端直接访问的静态资源 URL
  const url = `/uploads/${req.file.filename}`
  res.json({ code: 0, message: 'ok', data: { url } })
})
