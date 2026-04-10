import { Router } from 'express'
import multer from 'multer'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BizError } from '../utils/errors.js'

export const uploadRouter = Router()

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

  // 拼接得到可供前端直接访问的静态资源 URL
  const url = `/uploads/${req.file.filename}`
  res.json({ code: 0, message: 'ok', data: { url } })
})
