import { describe, expect, test } from 'bun:test'
import { isExtensionComposerActionId } from './composerActionOwnership'

describe('composer action ownership', () => {
  test('recognizes Suite-owned and extension-registered entries', () => {
    expect(isExtensionComposerActionId('chat.authors-note')).toBe(true)
    expect(isExtensionComposerActionId('chat.manage')).toBe(true)
    expect(isExtensionComposerActionId('chat.settings')).toBe(true)
    expect(isExtensionComposerActionId('settings')).toBe(true)
    expect(isExtensionComposerActionId('connectionsPicker')).toBe(true)
    expect(isExtensionComposerActionId('spindle:ext-1:tab:datacat:7')).toBe(true)
    expect(isExtensionComposerActionId('input-action:datacat:open')).toBe(true)
    expect(isExtensionComposerActionId('ext-cmd-datacat:open')).toBe(true)
  })

  test('keeps native composer actions available', () => {
    for (const id of ['home', 'regen', 'continue', 'connections', 'promptVariables', 'tools', 'extras']) {
      expect(isExtensionComposerActionId(id)).toBe(false)
    }
  })
})
