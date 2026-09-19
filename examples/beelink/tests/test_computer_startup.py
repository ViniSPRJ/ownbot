import importlib.util,json,unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('check',Path(__file__).parents[1] / 'ownbot-check-computer.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def fixture(networks=None):
 return {'Config':{'Labels':{'com.docker.compose.project':'openbot','com.docker.compose.service':'agent-computer'}},'HostConfig':{'NetworkMode':'openbot_default','PortBindings':{'4100/tcp':[{'HostIp':'127.0.0.1','HostPort':'4100'}]}},'State':{'Running':True,'Pid':123},'NetworkSettings':{'Networks':networks or {}}}
class StartupCheck(unittest.TestCase):
 def run_case(self,info):
  commands=[]
  def docker(*args):
   commands.append(args)
   if args[0]=='inspect':return json.dumps([info])
   if args[:2]==('network','inspect'):return json.dumps([{'Labels':{'com.docker.compose.project':'openbot'}}])
   if args[:2]==('network','connect'):
    info['NetworkSettings']['Networks']['openbot_default']={};return ''
   raise AssertionError(args)
  with patch.object(m,'docker',docker):result=m.ensure_network()
  return result,commands
 def test_recovers_missing_network_without_recreation(self):
  pid,commands=self.run_case(fixture());self.assertEqual(pid,123)
  self.assertEqual([c for c in commands if c[:2]==('network','connect')],[('network','connect','--alias','agent-computer','openbot_default','openbot-agent-computer-1')])
  self.assertTrue(all(c[0] in ('inspect','network') for c in commands))
 def test_attached_is_readonly(self):
  _,commands=self.run_case(fixture({'openbot_default':{}}));self.assertEqual(commands,[('inspect','openbot-agent-computer-1')]*2)
 def test_refuses_foreign_container(self):
  data=fixture();data['Config']['Labels']['com.docker.compose.project']='other'
  with self.assertRaisesRegex(RuntimeError,'ownership'):self.run_case(data)
 def test_refuses_unexpected_network(self):
  with self.assertRaisesRegex(RuntimeError,'unexpected network'):self.run_case(fixture({'other':{}}))
if __name__=='__main__':unittest.main()
