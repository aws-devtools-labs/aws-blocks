// Relative URL: /tenant-b/aws-blocks/api in path mode, /aws-blocks/api in subdomain mode.
fetch('aws-blocks/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
	.then((r) => r.json())
	.then((j) => { document.getElementById('api').textContent = JSON.stringify(j, null, 2); })
	.catch((e) => { document.getElementById('api').textContent = 'API error: ' + e; });
