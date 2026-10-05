"""Run only against the isolated p4-turn-admin-test container described in README."""
import json, subprocess, base64, os, threading, urllib.request
from server import Coturn, create_server
inspection = json.loads(subprocess.check_output(['docker', 'inspect', 'p4-turn-admin-test']))[0]
assert inspection['Config']['Image'] == 'coturn/coturn:4.6.3'
assert '--realm=abrupt-test' in inspection['Config']['Cmd']
assert '--min-port=41306' in inspection['Config']['Cmd']
assert '--max-port=41307' in inspection['Config']['Cmd']
import socket,struct,os,hashlib,hmac,time
COOKIE=0x2112a442

def attr(kind,value):
 return struct.pack('!HH',kind,len(value))+value+b'\0'*((-len(value))%4)
def packet(attrs,key=None):
 tx=os.urandom(12)
 if key:
  head=struct.pack('!HHI12s',3,len(attrs)+24,COOKIE,tx)
  attrs+=attr(8,hmac.new(key,head+attrs,hashlib.sha1).digest())
 return struct.pack('!HHI12s',3,len(attrs),COOKIE,tx)+attrs

def response(s,tcp):
 if tcp:
  def receive(n):
   b=b''
   while len(b)<n:
    chunk=s.recv(n-len(b))
    if not chunk:raise RuntimeError('TCP closed')
    b+=chunk
   return b
  head=receive(20);data=head+receive(struct.unpack('!H',head[2:4])[0])
 else:data=s.recv(65536)
 attrs={};idx=20
 while idx<len(data):
  kind,n=struct.unpack('!HH',data[idx:idx+4]);attrs[kind]=data[idx+4:idx+4+n];idx+=4+(n+3)//4*4
 return struct.unpack('!H',data[:2])[0],attrs

def allocate(tcp):
 s=socket.socket(socket.AF_INET,socket.SOCK_STREAM if tcp else socket.SOCK_DGRAM);s.settimeout(3);s.connect(('127.0.0.1',41304))
 requested=attr(0x19,b'\x11\0\0\0')
 s.sendall(packet(requested));kind,attrs=response(s,tcp)
 assert kind==0x113 and attrs[9][2:4]==b'\x04\x01',(kind,attrs)
 realm=attrs[0x14];nonce=attrs[0x15];username=b'abrupt-test'
 key=hashlib.md5(username+b':'+realm+b':test-password').digest()
 s.sendall(packet(requested+attr(6,username)+attr(0x14,realm)+attr(0x15,nonce),key))
 kind,attrs=response(s,tcp)
 return s,kind,attrs

def port(attrs):return struct.unpack('!H',attrs[0x16][2:4])[0]^(COOKIE>>16)


client = Coturn('127.0.0.1', 5766, 'private-test-password-at-least-24')
assert not client.sessions(), 'Test requires an empty isolated allocation pool'
first,kind,attrs=allocate(False);assert kind==0x103;first_port=port(attrs);first.close()
second,kind,attrs=allocate(False);assert kind==0x103;second.close()
sessions=client.sessions();assert len(sessions)==2,sessions
selected=next(s for s in sessions if any(addr.endswith(':'+str(first_port)) for addr in s['relays']))
other=next(s for s in sessions if s['id']!=selected['id'])
os.environ.update(TURN_ADMIN_ENABLED='true', TURN_ADMIN_PASSWORD='private-test-password-at-least-24')
server=create_server(port=0)
thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
try:
 url=f'http://127.0.0.1:{server.server_port}'
 auth='Basic '+base64.b64encode(b'admin:private-test-password-at-least-24').decode()
 request=urllib.request.Request(url+'/api/release',data=json.dumps({'sessionId':selected['id']}).encode(),headers={'Authorization':auth,'X-Turn-Control':'release'})
 with urllib.request.urlopen(request,timeout=5) as http_response: assert json.load(http_response)['released']
 with urllib.request.urlopen(urllib.request.Request(url+'/api/status',headers={'Authorization':auth}),timeout=5) as http_response:
  assert [s['id'] for s in json.load(http_response)['sessions']]==[other['id']]
finally:
 server.shutdown();server.server_close();thread.join()
assert [s['id'] for s in client.sessions()]==[other['id']]
replacement,kind,attrs=allocate(False);assert kind==0x103;assert port(attrs)==first_port;replacement.close()
print('Targeted cancellation freed UDP port immediately; other allocation preserved')
for session in client.sessions(): client.release(session['id'])
