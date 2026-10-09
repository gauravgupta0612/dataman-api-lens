from flask import Flask, request, Blueprint
app = Flask(__name__)
bp = Blueprint('auth', __name__, url_prefix='/auth')

@bp.route('/login', methods=['POST'])
def login():
    data = request.get_json()
    username = data['username']
    password = data.get('password')
    return {}

@app.route('/search')
def search():
    term = request.args.get('q')
    return []

app.register_blueprint(bp, url_prefix='/v1')
if __name__ == '__main__':
    app.run(port=5050)
