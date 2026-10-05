"""Optional browser smoke check: requires Playwright and a local Chromium."""
import json
import os
from playwright.sync_api import sync_playwright, expect

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH', '/Applications/Chromium.app/Contents/MacOS/Chromium'), headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors, external, failed = [], [], []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.on('request', lambda request: external.append(request.url) if not request.url.startswith(('http://127.0.0.1:3080/', 'data:', 'blob:', 'about:')) else None)
    page.on('response', lambda response: failed.append(f'{response.status} {response.url}') if response.status >= 400 else None)
    page.goto('http://127.0.0.1:3080/operator/')
    expect(page.locator('#connection')).to_contain_text('8대')
    page.screenshot(path='/private/tmp/p4-presentation-dashboard.png')
    page.locator('[data-rail="fleet"]').click()
    page.locator('#fleet-results button').first.click()
    expect(page.locator('#live-view-panel')).to_be_visible()
    page.wait_for_timeout(1200)
    expect(page.locator('#live-view-loading')).to_be_hidden()
    expect(page.locator('#live-view-panel')).to_contain_text('자동차 2')
    page.screenshot(path='/private/tmp/p4-presentation-video.png')
    page.locator('[data-rail="assistant"]').click()
    page.locator('#assistant-question').fill('차량 현황을 알려줘')
    page.locator('#assistant-question').press('Enter')
    expect(page.locator('#assistant-drawer')).to_contain_text('고정된 샘플 데이터', timeout=10000)
    expect(page.locator('#assistant-stop')).to_be_hidden()
    page.screenshot(path='/private/tmp/p4-presentation-assistant.png')
    page.locator('[data-rail="settings"]').click()
    expect(page.locator('#telemetry-mode-status')).to_contain_text('Replay dataset')
    page.locator('#virtual-workspace-tab').click()
    expect(page.locator('#virtual-scenario')).to_contain_text('부산 발표 시나리오')
    expect(page.locator('#virtual-vehicle option')).to_have_count(4)
    print(json.dumps({'errors': errors, 'external_requests': external, 'failed_requests': failed}, ensure_ascii=False))
    browser.close()
    assert not errors and not external and not failed
