import base64
from io import BytesIO
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from PIL import Image
import pymupdf
from werkzeug.datastructures import FileStorage
from cancellation import CancellationToken, OperationCancelled
from document_input import DocumentReader
from local_ocr import LocalOcrRuntime, LocalImageReader
from local_materials import LocalMaterialParser
from llm import ModelError
from web import create_app


def image_bytes():
    output=BytesIO();Image.new('RGB',(140,60),'white').save(output,format='PNG')
    return output.getvalue()


class FakeRuntime:
    available=True
    def __init__(self):self.calls=0
    def public(self):return {'available':True,'model':'GLM-OCR test','running':False}
    def read(self,raw,cancel_token=None):
        self.calls+=1
        if cancel_token:cancel_token.check();cancel_token.report('GLM 测试识别',phase='ocr-reading')
        return r'一、1. 求 $\sqrt{x\sqrt{x}}-1$。参考答案：$2$。'
    def close(self):pass


class RecordingModel:
    def __init__(self):self.requests=[]
    def complete(self,messages,tools=None):
        self.requests.append(messages)
        if '以下 JSON 中的 text' in messages[-1].get('content',''):
            return {'role':'assistant','content':json.dumps({'exercises':[{'number':'一、1','paper':'1 测试卷','topic':'极限','question':r'$\sqrt{x\sqrt{x}}-1$','answer':'2','page_index':1}],'warnings':[]})}
        return {'role':'assistant','content':'已根据本机识别的原稿核对。'}


class RuntimeTests(unittest.TestCase):
    def runtime(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        runtime=LocalOcrRuntime(Path(directory.name),idle_seconds=60,timeout=2)
        self.addCleanup(runtime.close)
        return runtime

    def test_missing_weights_fail_without_remote_fallback(self):
        runtime=self.runtime()
        with patch('local_ocr.urlopen') as network, self.assertRaises(ModelError):
            runtime.read(image_bytes())
        network.assert_not_called()

    def test_waiting_cancellation_does_not_stop_another_read(self):
        runtime=self.runtime();token=CancellationToken();errors=[]
        runtime.lock.acquire()
        def read():
            try:runtime.read(image_bytes(),token)
            except Exception as error:errors.append(error)
        thread=threading.Thread(target=read);thread.start();token.cancel();thread.join(2)
        self.assertFalse(thread.is_alive());runtime.lock.release()
        self.assertIsInstance(errors[0],OperationCancelled)

    def test_request_uses_loopback_fixed_prompt_and_cache(self):
        runtime=self.runtime()
        class Process:
            def poll(self):return None
            def terminate(self):pass
            def wait(self,timeout=None):return 0
        runtime.process=Process();runtime.base='http://127.0.0.1:65432'
        captured=[]
        class Response:
            def __enter__(self):return BytesIO(json.dumps({'choices':[{'message':{'content':'公式 $x^2$'},'finish_reason':'stop'}]}).encode())
            def __exit__(self,*args):pass
        def send(request,timeout):captured.append(request);return Response()
        with patch.object(runtime,'_start'),patch.object(runtime,'memory',return_value=(5*2**30,1500*2**20)),patch('local_ocr.urlopen',side_effect=send):
            self.assertEqual(runtime.read(image_bytes()),'公式 $x^2$')
            self.assertEqual(runtime.read(image_bytes()),'公式 $x^2$')
        self.assertEqual(len(captured),1)
        self.assertTrue(captured[0].full_url.startswith('http://127.0.0.1:'))
        payload=json.loads(captured[0].data)
        self.assertEqual(payload['messages'][0]['content'][-1]['text'],'Text Recognition:')
        self.assertNotIn('Authorization',captured[0].headers)

    def test_active_cancel_kills_owned_server(self):
        runtime=self.runtime();token=CancellationToken();errors=[];started=threading.Event();stopped=threading.Event()
        class Process:
            def poll(self):return 0 if stopped.is_set() else None
            def terminate(self):stopped.set()
            def wait(self,timeout=None):return 0
        runtime.process=Process();runtime.base='http://127.0.0.1:65432'
        def send(*args,**kwargs):
            started.set();stopped.wait(3);raise OSError('server stopped')
        def read():
            try:runtime.read(image_bytes(),token)
            except Exception as error:errors.append(error)
        with patch.object(runtime,'_start'),patch.object(runtime,'memory',return_value=(5*2**30,1500*2**20)),patch('local_ocr.urlopen',side_effect=send):
            thread=threading.Thread(target=read);thread.start();self.assertTrue(started.wait(2));token.cancel();thread.join(2)
        self.assertFalse(thread.is_alive());self.assertTrue(stopped.is_set());self.assertIsInstance(errors[0],OperationCancelled)

    def test_truncated_output_is_rejected(self):
        runtime=self.runtime()
        class Process:
            def poll(self):return None
            def terminate(self):pass
            def wait(self,timeout=None):return 0
        runtime.process=Process();runtime.base='http://127.0.0.1:65432'
        class Response:
            def __enter__(self):return BytesIO(b'{"choices":[{"message":{"content":"partial"},"finish_reason":"length"}]}')
            def __exit__(self,*args):pass
        with patch.object(runtime,'_start'),patch.object(runtime,'memory',return_value=(5*2**30,1500*2**20)),patch('local_ocr.urlopen',return_value=Response()),self.assertRaises(ModelError):
            runtime.read(image_bytes())
        self.assertFalse(runtime.cache)


class SharedReaderTests(unittest.TestCase):
    def test_native_pdf_math_uses_glm_and_keeps_physical_page(self):
        with pymupdf.open() as pdf:
            page=pdf.new_page();page.insert_text((30,50),'Exercise with a native text layer and a root formula.')
            raw=pdf.tobytes()
        runtime=FakeRuntime()
        result=DocumentReader(lambda:LocalImageReader(runtime),prefer_visual=True).read([FileStorage(stream=BytesIO(raw),filename='test.pdf')])
        self.assertEqual(runtime.calls,1);self.assertIn(r'\sqrt{x\sqrt{x}}',result['text'])
        self.assertEqual(result['pages'],[{'source':'test.pdf','page':1,'method':'local-glm'}])

    def test_native_pdf_without_ocr_does_not_construct_cloud_reader(self):
        with pymupdf.open() as pdf:
            page=pdf.new_page();page.insert_text((30,50),'Exercise readable native PDF that requires no key.')
            raw=pdf.tobytes()
        def no_key():raise AssertionError('unneeded API configuration')
        result=DocumentReader(no_key).read([FileStorage(stream=BytesIO(raw),filename='test.pdf')])
        self.assertIn('Exercise',result['text'])

    def test_local_parser_keeps_images_local_and_checkpoints_ocr(self):
        runtime=FakeRuntime();client=RecordingModel();parser=LocalMaterialParser(client,LocalImageReader(runtime))
        image='data:image/png;base64,'+base64.b64encode(image_bytes()).decode()
        documents=[{'source':'试卷.pdf','page':17,'page_index':1,'image':image}]
        cache={};result=parser.parse_images(documents,checkpoint=lambda k,v:cache.update({k:v}))
        self.assertEqual(runtime.calls,1);self.assertEqual(result['input_mode'],'local-glm')
        self.assertEqual(result['exercises'][0]['page_index'],1)
        self.assertTrue(any(k.startswith('ocr:') for k in cache))
        self.assertNotIn('image_url',json.dumps(client.requests))
        self.assertIn('17',json.dumps(client.requests))
        LocalMaterialParser(client,LocalImageReader(runtime)).parse_images(documents,cached_segments=cache)
        self.assertEqual(runtime.calls,1)

    def test_both_web_entrances_share_local_reader_and_chat_sends_text(self):
        with tempfile.TemporaryDirectory() as folder:
            runtime=FakeRuntime();client=RecordingModel()
            app=create_app(folder,client_factory=lambda:client,settings_path=Path(folder)/'settings.json',local_ocr_runtime=runtime)
            self.addCleanup(app.extensions['stop_background'])
            browser=app.test_client()
            status=browser.get('/api/status').json
            self.assertTrue(status['local_ocr']);self.assertIn('GLM',status['ocr_model'])
            for route in ('/api/intake/read','/api/materials/read'):
                response=browser.post(route,data={'files':(BytesIO(image_bytes()),'test.png')})
                self.assertEqual(response.status_code,200,response.json)
                self.assertIn('sqrt',response.json['text'])
            # Optional preview -> chat must reuse its transcript rather than recognize twice.
            read=browser.post('/api/intake/read',data={'files':(BytesIO(image_bytes()),'reused.png')}).json
            calls=runtime.calls
            reused=browser.post('/api/chat',json={'message':'继续整理','view':'organize','image_ids':read['image_ids']})
            self.assertEqual(reused.status_code,200,reused.json);self.assertEqual(runtime.calls,calls)
            prepared=browser.post('/api/intake/prepare',data={'files':(BytesIO(image_bytes()),'test.png')}).json
            reply=browser.post('/api/chat',json={'message':'帮我看看这题','view':'organize','image_ids':prepared['image_ids']})
            self.assertEqual(reply.status_code,200,reply.json)
            self.assertNotIn('image_url',json.dumps(client.requests))
            self.assertIn('GLM-OCR',json.dumps(client.requests))
            self.assertEqual(browser.get('/api/operation?request_id=unknown').json['progress'],{})


if __name__=='__main__':unittest.main()
