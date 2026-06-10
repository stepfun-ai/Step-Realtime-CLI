import fs from 'node:fs'

console.log('✓ Post-build: writing build stamp...')

fs.writeFileSync(
  'dist/build-info.json',
  JSON.stringify({
    version: process.env.npm_package_version,
    builtAt: new Date().toISOString()
  })
)

if (fs.existsSync('skills/templates')) {
  fs.cpSync('skills/templates', 'dist/templates', { recursive: true })
}

console.log('✅ step-cli 项目构建完成！')
