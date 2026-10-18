import provider_status as providers


def test_attempts_are_bounded_and_no_error_details_leak():
    providers.record('cboe', 'SPX', ValueError('secret-like value must never escape'))
    row = next(r for r in providers.snapshot() if r['provider'] == 'cboe' and r['symbol'] == 'SPX')
    assert row['error'] == 'ValueError'
    assert 'secret-like' not in str(row)
    size = len(providers.snapshot())
    providers.record('untrusted-provider', 'SPX')
    providers.record('yahoo', 'unknown-symbol')
    assert len(providers.snapshot()) == size
    providers.record('cboe', 'SPX')
    row = next(r for r in providers.snapshot() if r['provider'] == 'cboe' and r['symbol'] == 'SPX')
    assert row['ok'] and row['last_success'] and row['error'] is None


def test_tracking_preserves_exception_without_fabricating_a_success():
    import pytest
    @providers.tracked('deribit')
    def fail(symbol):
        raise ConnectionError('unavailable')
    with pytest.raises(ConnectionError):
        fail('BTC')
    assert next(r for r in providers.snapshot() if r['symbol'] == 'BTC')['ok'] is False


def test_source_readiness_is_read_only_and_does_not_expose_credentials(monkeypatch):
    from fastapi.testclient import TestClient
    import app as server
    monkeypatch.setenv('GEX_VIEWER_TOKEN', '')
    monkeypatch.setenv('GEX_ADMIN_TOKEN', 'not-for-public-output')
    monkeypatch.setenv('GEX_DEMO_MODE', 'false')
    client = TestClient(server.app)
    response = client.get('/api/data-status')
    assert response.status_code == 200
    body = response.json()
    assert body['demo'] is False
    assert {p['name'] for p in body['providers']} == {'CBOE', 'Yahoo', 'Deribit'}
    assert 'not-for-public-output' not in response.text
    assert 'password' not in response.text
    assert client.get('/api/rithmic').status_code == 401
    assert client.get('/classic/').status_code == 200


def test_built_react_is_primary_and_classic_assets_are_preserved():
    import os
    import app as server
    from fastapi.testclient import TestClient
    client = TestClient(server.app)
    assert client.get('/classic/styles.css').status_code == 200
    if os.path.isfile(os.path.join(server.REACT_FRONTEND, 'index.html')):
        response = client.get('/', follow_redirects=False)
        assert response.status_code == 307
        assert response.headers['location'] == '/react/'
        assert client.get('/react/').status_code == 200
