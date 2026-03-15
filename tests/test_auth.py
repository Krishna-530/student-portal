import unittest
import json
from app import app

class AuthTestCase(unittest.TestCase):
    def setUp(self):
        self.app = app.test_client()
        self.app.testing = True

    def test_login_success(self):
        response = self.app.post('/api/auth/login', 
            data=json.dumps({
                'username': 'student',
                'password': 'student123',
                'userType': 'student'
            }),
            content_type='application/json'
        )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.data)
        self.assertTrue(data['success'])
        self.assertIn('user', data)

    def test_login_failure_wrong_password(self):
        response = self.app.post('/api/auth/login', 
            data=json.dumps({
                'username': 'student',
                'password': 'wrongpassword',
                'userType': 'student'
            }),
            content_type='application/json'
        )
        self.assertEqual(response.status_code, 401)
        data = json.loads(response.data)
        self.assertFalse(data['success'])
        self.assertEqual(data['message'], 'Invalid credentials')

    def test_login_failure_missing_fields(self):
        response = self.app.post('/api/auth/login', 
            data=json.dumps({
                'username': 'student',
                'password': 'student123'
                # missing userType
            }),
            content_type='application/json'
        )
        # Depending on backend validation, this might be 400 or 401
        self.assertIn(response.status_code, [400, 401])

if __name__ == '__main__':
    unittest.main()
