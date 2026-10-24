import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ios/TempCode/project.yml is what xcodegen writes Info.plist from at every
 * build; these pins keep the iPhone Duo's contract (docs/IOS-DESIGN.md
 * "iPhone Duo"): the outer display's orientations, the 18.0 target, the
 * iPhone family alone, and no UIRequiresFullScreen (Apple honours it, and
 * it would only shrink the app without opting it out of resizing).
 */
const yml = readFileSync(resolve(import.meta.dirname, '../ios/TempCode/project.yml'), 'utf8')

describe('ios/TempCode/project.yml', () => {
  it('allows portrait and both landscapes, never upside down', () => {
    const block = yml.match(/UISupportedInterfaceOrientations:\n((?: {10}- .*\n)+)/)?.[1] ?? ''
    const listed = block.split('\n').filter(Boolean).map((l) => l.trim().replace(/^- /, ''))
    expect(listed).toEqual(['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight'])
  })

  it('targets iOS 18.0 and the iPhone family', () => {
    expect(yml).toMatch(/deploymentTarget:\n\s+iOS: "18\.0"/)
    expect(yml).toContain('IPHONEOS_DEPLOYMENT_TARGET: "18.0"')
    expect(yml).toContain('TARGETED_DEVICE_FAMILY: "1"')
  })

  it('never requires full screen', () => {
    expect(yml).not.toContain('UIRequiresFullScreen')
  })

  it('keeps the launch screen the Duo prepare page asks for', () => {
    expect(yml).toContain('UILaunchScreen: {}')
  })
})
