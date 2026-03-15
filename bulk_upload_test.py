import requests

url = "http://127.0.0.1:5000/api/admin/bulk_add_users"
file_path = "test_users.csv"
description = "Test bulk upload"

with open(file_path, "rb") as f:
    files = {"file": (file_path, f, "application/vnd.ms-excel")}
    data = {"description": description}
    response = requests.post(url, files=files, data=data)

print("Status Code:", response.status_code)
print("Response JSON:", response.json())
