var timers = require( "timers" );

function pipe() {

}

pipe.prototype.exec = function( ops, callback, context )
{
    var self = context || this;

    ops = ops || this.ops || [];

    if( ops.length === 0 )
    {
        return callback.call( self, null, null );
    }

    var i = 0;

    self.lastresult = null;
    self.lasterr = null;

    if( !self.finish )
    {
        self.finish = function( err, result )
        {
            return callback.call( self, err, result );
        };
    }

    function next( err, result )
    {
        self.lasterr = err;
        self.lastresult = result;
        if( err )
        {
            if( self.trace )
            {
                console.error( "error at step:" + i );
                console.error( err );
            }
            if( !self.suppressErrors )
            {

                return callback.call( self, err );
            }
        }

        i++;

        if( i >= ops.length )
        {
            return callback.call( self, self.lasterr, self.lastresult );
        }

        if( self.trace )
        {
            console.info( "executing step:" + i );
        }

        try
        {
            if( ops[i].fn )
            {
                timers.setImmediate( function()
                {
                    ops[i].fn.call( self, next, ops[i].data )
                } );
            }
            else
            {
                if( ops[i].constructor == Array )
                {
                    process.nextTick( function()
                    {
                        var sub_pipe = new pipe();
                        sub_pipe.exec( ops[i], next );
                    } );
                }
                else
                {
                    timers.setImmediate( function()
                    {
                        ops[i].call( self, next )
                    } );
                }
            }
        }
        catch( e )
        {
            console.error( "!exception executing step:" + i );
            console.error( e );
            console.error( e.message || "" );
            console.error( e.stack || "" );
        }
    }

    if( self.trace )
    {
        console.error( "executing step:" + i );
    }

    //call first step
    try
    {
        var op = ops[i];
        //function + data
        if( op.data && op.fn )
        {
            op.fn.call( self, next, op.data );
        }
        else
        {
            //array
            if( op.constructor == Array )
            {
                var sub_pipe = new pipe();

                sub_pipe.exec( op, next );
            }
            //function
            else
            {
                op.call( self, next );
            }
        }
    }
    catch( e )
    {
        console.error( "exception executing step:" + i );
        console.error( e );
        console.error( e.message || "" );
        console.error( e.stack || "" );
        //	throw e;
    }
};

exports.create = function() {
    return new pipe();
}